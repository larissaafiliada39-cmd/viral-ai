
import 'dotenv/config';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';
import { chromium } from 'playwright';
import { nanoid } from 'nanoid';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// Usa uma pasta temporária gravável no Hostless.
const DATA = '/tmp/viral-ai-data';
const VIDEOS = path.join(DATA, 'videos');
const JOBS_FILE = path.join(DATA, 'jobs.json');

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.MODEL || 'gemini-omni-1.1-flash';

const app = express();

// Chave recebida pelo aplicativo: fica somente na memória.
let runtimeGeminiKey = '';

await fs.mkdir(VIDEOS, { recursive: true });

let jobs = {};

try {
  jobs = JSON.parse(await fs.readFile(JOBS_FILE, 'utf8'));
} catch {
  jobs = {};
}

const persist = async () => {
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2));
};

const getGeminiKey = () =>
  runtimeGeminiKey ||
  (process.env.GEMINI_API_KEY &&
   process.env.GEMINI_API_KEY !== 'cole_sua_chave_aqui'
    ? process.env.GEMINI_API_KEY
    : '');

const hasKey = () => Boolean(getGeminiKey());

const ai = () => {
  const key = getGeminiKey();

  if (!key) throw new Error('GEMINI_KEY_MISSING');

  return new GoogleGenAI({ apiKey: key });
};

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors({
  origin: process.env.APP_ORIGIN
    ? process.env.APP_ORIGIN.split(',')
    : true
}));

app.use(express.json({ limit: '2mb' }));

app.use('/api/', rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
}));

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    provider: 'Google Gemini',
    model: MODEL,
    keyConfigured: hasKey(),
    setupUrl: 'https://aistudio.google.com/api-keys'
  });
});

// Testa se o Chromium instalado pelo Playwright consegue abrir.
let browserCheckRunning = false;

app.get('/api/flow/browser-check', async (_req, res) => {
  if (browserCheckRunning) {
    return res.status(409).json({
      ok: false,
      error: 'Já existe um teste do navegador em andamento.'
    });
  }

  browserCheckRunning = true;

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const page = await browser.newPage();

    await page.goto('about:blank');

    const version = browser.version();

    await browser.close();
    browser = null;

    return res.json({
      ok: true,
      browser: 'Chromium',
      version,
      pageOpened: true,
      message: 'O Chromium abriu uma página de teste com sucesso.'
    });

  } catch (error) {
    if (browser) {
      await browser.close().catch(() => {});
    }

    console.error('Erro no teste do Chromium:', error);

    return res.status(500).json({
      ok: false,
      error: String(error.message || 'Falha ao iniciar o Chromium').slice(0, 700)
    });

  } finally {
    browserCheckRunning = false;
  }
});

// Recebe a chave Gemini pelo próprio aplicativo.
app.post('/api/settings/gemini-key', (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim();

  if (!apiKey || apiKey.length > 500) {
    return res.status(400).json({
      error: 'A chave informada é inválida.'
    });
  }

  runtimeGeminiKey = apiKey;

  res.json({
    ok: true,
    keyConfigured: true,
    message: 'Chave recebida pelo servidor.'
  });
});

app.get('/api/projects', (_req, res) => {
  res.json({
    projects: Object.values(jobs).map(
      ({ id, title, status, scenes, createdAt, finalUrl }) => ({
        id,
        title,
        status,
        scenes: scenes.length,
        createdAt,
        finalUrl
      })
    )
  });
});

app.get('/api/projects/:id', (req, res) => {
  const job = jobs[req.params.id];

  if (!job) {
    return res.status(404).json({
      error: 'Projeto não encontrado.'
    });
  }

  res.json(job);
});

app.post('/api/projects', async (req, res) => {
  const {
    title,
    scenes,
    aspectRatio = '9:16'
  } = req.body || {};

  if (
    !title ||
    !Array.isArray(scenes) ||
    scenes.length < 1 ||
    scenes.length > 40
  ) {
    return res.status(400).json({
      error: 'Informe título e de 1 a 40 cenas.'
    });
  }

  if (!['9:16', '16:9'].includes(aspectRatio)) {
    return res.status(400).json({
      error: 'Proporção inválida.'
    });
  }

  const normalized = scenes.map((scene, index) => ({
    id: nanoid(8),
    number: index + 1,
    prompt: String(scene.prompt || '').trim().slice(0, 12000),
    status: 'pending',
    videoUrl: null,
    error: null
  }));

  if (normalized.some(scene => !scene.prompt)) {
    return res.status(400).json({
      error: 'Cada cena precisa de um prompt.'
    });
  }

  const id = nanoid(12);

  jobs[id] = {
    id,
    title: String(title).slice(0, 120),
    aspectRatio,
    status: 'draft',
    scenes: normalized,
    createdAt: new Date().toISOString(),
    finalUrl: null
  };

  await persist();

  res.status(201).json(jobs[id]);
});

async function generateScene(project, scene) {
  scene.status = 'generating';
  scene.error = null;

  await persist();

  try {
    const interaction = await ai().interactions.create({
      model: MODEL,
      input: scene.prompt,
      response_format: {
        type: 'video',
        aspect_ratio: project.aspectRatio,
        resolution: '720p'
      }
    });

    const b64 = interaction.output_video?.data;

    if (!b64) {
      throw new Error(
        'O Gemini não retornou um arquivo de vídeo nesta resposta.'
      );
    }

    const filename = `${project.id}_${scene.id}.mp4`;

    await fs.writeFile(
      path.join(VIDEOS, filename),
      Buffer.from(b64, 'base64')
    );

    scene.status = 'completed';
    scene.videoUrl = `/media/${filename}`;

  } catch (error) {
    scene.status = 'error';

    scene.error =
      error.message === 'GEMINI_KEY_MISSING'
        ? 'A chave Gemini ainda não foi configurada.'
        : String(error.message || 'Falha na geração').slice(0, 500);
  }

  await persist();
}

async function runProject(id) {
  const project = jobs[id];

  if (!project) return;

  project.status = 'generating';
  await persist();

  for (const scene of project.scenes) {
    if (scene.status !== 'completed') {
      await generateScene(project, scene);
    }
  }

  project.status = project.scenes.every(
    scene => scene.status === 'completed'
  )
    ? 'completed'
    : 'needs_attention';

  await persist();
}

app.post('/api/projects/:id/generate', async (req, res) => {
  const project = jobs[req.params.id];

  if (!project) {
    return res.status(404).json({
      error: 'Projeto não encontrado.'
    });
  }

  if (!hasKey()) {
    return res.status(409).json({
      error: 'GEMINI_KEY_MISSING',
      setupUrl: 'https://aistudio.google.com/api-keys'
    });
  }

  if (project.status === 'generating') {
    return res.status(409).json({
      error: 'Este projeto já está em geração.'
    });
  }

  project.status = 'queued';
  await persist();

  res.json({
    accepted: true,
    projectId: project.id,
    status: project.status
  });

  setImmediate(() => runProject(project.id));
});

app.post(
  '/api/projects/:id/scenes/:sceneId/regenerate',
  async (req, res) => {
    const project = jobs[req.params.id];

    const scene = project?.scenes.find(
      item => item.id === req.params.sceneId
    );

    if (!project || !scene) {
      return res.status(404).json({
        error: 'Projeto ou cena não encontrado.'
      });
    }

    if (!hasKey()) {
      return res.status(409).json({
        error: 'GEMINI_KEY_MISSING'
      });
    }

    if (project.status === 'generating') {
      return res.status(409).json({
        error: 'Aguarde a geração atual terminar.'
      });
    }

    if (req.body?.prompt) {
      scene.prompt = String(req.body.prompt).slice(0, 12000);
    }

    project.status = 'generating';
    scene.status = 'pending';

    await persist();

    res.json({
      accepted: true,
      sceneId: scene.id
    });

    setImmediate(async () => {
      await generateScene(project, scene);

      project.status = project.scenes.every(
        item => item.status === 'completed'
      )
        ? 'completed'
        : 'needs_attention';

      await persist();
    });
  }
);

function ffmpegConcat(files, output) {
  return new Promise((resolve, reject) => {
    const list = path.join(DATA, `concat_${nanoid(8)}.txt`);

    fs.writeFile(
      list,
      files.map(file =>
        `file '${file.replaceAll("'", "'\\''")}'`
      ).join('\n')
    ).then(() => {
      const child = spawn('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', list,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        output
      ]);

      let errorOutput = '';

      child.stderr.on('data', data => {
        errorOutput += data.toString();
      });

      child.on('close', async code => {
        await fs.rm(list, { force: true });

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(
            errorOutput.slice(-1200) || 'Falha no FFmpeg.'
          ));
        }
      });

      child.on('error', reject);
    }).catch(reject);
  });
}

app.post('/api/projects/:id/merge', async (req, res) => {
  const project = jobs[req.params.id];

  if (!project) {
    return res.status(404).json({
      error: 'Projeto não encontrado.'
    });
  }

  if (
    project.status === 'generating' ||
    project.scenes.some(scene => scene.status !== 'completed')
  ) {
    return res.status(409).json({
      error: 'Todas as cenas precisam estar concluídas antes da montagem.'
    });
  }

  const files = project.scenes.map(scene =>
    path.join(VIDEOS, path.basename(scene.videoUrl))
  );

  const outputName = `${project.id}_final.mp4`;
  const output = path.join(VIDEOS, outputName);

  try {
    await ffmpegConcat(files, output);

    project.finalUrl = `/media/${outputName}`;
    project.status = 'completed';

    await persist();

    res.json({
      ok: true,
      finalUrl: project.finalUrl
    });
  } catch (error) {
    res.status(500).json({
      error: `Não foi possível unir os clipes: ${error.message}`
    });
  }
});

app.use('/media', express.static(VIDEOS));

app.use((error, req, res, next) => {
  console.error('Erro no servidor:', error.message);

  res.status(500).json({
    error: 'Erro interno no servidor.'
  });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VIRAL AI backend ativo na porta ${PORT}`);
});
