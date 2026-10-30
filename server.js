
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';
import { nanoid } from 'nanoid';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// Usa uma pasta temporária gravável para os dados.
const DATA = '/tmp/viral-ai-data';
const VIDEOS = path.join(DATA, 'videos');
const JOBS_FILE = path.join(DATA, 'jobs.json');

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.MODEL || 'gemini-omni-1.1-flash';

const app = express();

await fs.mkdir(DATA, { recursive: true });
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

const hasKey = () =>
  Boolean(
    process.env.GEMINI_API_KEY &&
    process.env.GEMINI_API_KEY !== 'cole_sua_chave_aqui'
  );

const ai = () => {
  if (!hasKey()) throw new Error('GEMINI_KEY_MISSING');
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
};

const safeName = s =>
  String(s).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

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

app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    provider: 'Google Gemini',
    model: MODEL,
    keyConfigured: hasKey(),
    setupUrl: 'https://aistudio.google.com/api-keys'
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
  const j = jobs[req.params.id];

  if (!j) {
    return res.status(404).json({ error: 'Projeto não encontrado.' });
  }

  res.json(j);
});

app.post('/api/projects', async (req, res) => {
  const { title, scenes, aspectRatio = '9:16' } = req.body || {};

  if (!title || !Array.isArray(scenes) || scenes.length < 1 || scenes.length > 40) {
    return res.status(400).json({
      error: 'Informe título e de 1 a 40 cenas.'
    });
  }

  if (!['9:16', '16:9'].includes(aspectRatio)) {
    return res.status(400).json({ error: 'Proporção inválida.' });
  }

  const normalized = scenes.map((s, i) => ({
    id: nanoid(8),
    number: i + 1,
    prompt: String(s.prompt || '').trim().slice(0, 12000),
    status: 'pending',
    videoUrl: null,
    error: null
  }));

  if (normalized.some(s => !s.prompt)) {
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
      throw new Error('O Gemini não retornou um arquivo de vídeo nesta resposta.');
    }

    const filename =
      `${safeName(project.id)}_${safeName(scene.id)}.mp4`;

    await fs.writeFile(
      path.join(VIDEOS, filename),
      Buffer.from(b64, 'base64')
    );

    scene.status = 'completed';
    scene.videoUrl = `/media/${filename}`;
  } catch (e) {
    scene.status = 'error';
    scene.error =
      e.message === 'GEMINI_KEY_MISSING'
        ? 'A chave Gemini ainda não foi configurada no servidor.'
        : String(e.message || 'Falha na geração').slice(0, 500);
  }

  await persist();
}

async function runProject(id) {
  const project = jobs[id];

  project.status = 'generating';
  await persist();

  for (const scene of project.scenes) {
    if (scene.status !== 'completed') {
      await generateScene(project, scene);
    }
  }

  project.status = project.scenes.every(
    s => s.status === 'completed'
  ) ? 'completed' : 'needs_attention';

  await persist();
}

app.post('/api/projects/:id/generate', async (req, res) => {
  const p = jobs[req.params.id];

  if (!p) {
    return res.status(404).json({ error: 'Projeto não encontrado.' });
  }

  if (!hasKey()) {
    return res.status(409).json({
      error: 'GEMINI_KEY_MISSING',
      setupUrl: 'https://aistudio.google.com/api-keys'
    });
  }

  if (p.status === 'generating') {
    return res.status(409).json({
      error: 'Este projeto já está em geração.'
    });
  }

  p.status = 'queued';
  await persist();

  res.json({
    accepted: true,
    projectId: p.id,
    status: p.status
  });

  setImmediate(() => runProject(p.id));
});

app.post('/api/projects/:id/scenes/:sceneId/regenerate', async (req, res) => {
  const p = jobs[req.params.id];
  const s = p?.scenes.find(x => x.id === req.params.sceneId);

  if (!p || !s) {
    return res.status(404).json({
      error: 'Projeto ou cena não encontrado.'
    });
  }

  if (!hasKey()) {
    return res.status(409).json({
      error: 'GEMINI_KEY_MISSING',
      setupUrl: 'https://aistudio.google.com/api-keys'
    });
  }

  if (p.status === 'generating') {
    return res.status(409).json({
      error: 'Aguarde a geração atual terminar.'
    });
  }

  if (req.body?.prompt) {
    s.prompt = String(req.body.prompt).slice(0, 12000);
  }

  p.status = 'generating';
  s.status = 'pending';
  await persist();

  res.json({ accepted: true, sceneId: s.id });

  setImmediate(async () => {
    await generateScene(p, s);

    p.status = p.scenes.every(
      x => x.status === 'completed'
    ) ? 'completed' : 'needs_attention';

    await persist();
  });
});

function ffmpegConcat(files, output) {
  return new Promise((resolve, reject) => {
    const list = path.join(DATA, `concat_${nanoid(8)}.txt`);

    fs.writeFile(
      list,
      files.map(f => `file '${f.replaceAll("'", "'\\''")}'`).join('\n')
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

      let err = '';

      child.stderr.on('data', d => {
        err += d.toString();
      });

      child.on('close', async code => {
        await fs.rm(list, { force: true });

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(err.slice(-1200) || 'Falha no FFmpeg'));
        }
      });

      child.on('error', reject);
    }).catch(reject);
  });
}

app.post('/api/projects/:id/merge', async (req, res) => {
  const p = jobs[req.params.id];

  if (!p) {
    return res.status(404).json({ error: 'Projeto não encontrado.' });
  }

  if (p.status === 'generating' || p.scenes.some(s => s.status !== 'completed')) {
    return res.status(409).json({
      error: 'Todas as cenas precisam estar concluídas antes da montagem.'
    });
  }

  const files = p.scenes.map(
    s => path.join(VIDEOS, path.basename(s.videoUrl))
  );

  const outputName = `${safeName(p.id)}_final.mp4`;
  const output = path.join(VIDEOS, outputName);

  try {
    await ffmpegConcat(files, output);

    p.finalUrl = `/media/${outputName}`;
    p.status = 'completed';

    await persist();

    res.json({ ok: true, finalUrl: p.finalUrl });
  } catch (e) {
    res.status(500).json({
      error: `Não foi possível unir os clipes: ${e.message}`
    });
  }
});

app.use('/media', express.static(VIDEOS, {
  fallthrough: false,
  setHeaders: r =>
    r.setHeader('Cache-Control', 'private, max-age=3600')
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno no servidor.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VIRAL AI backend ativo na porta ${PORT}`);
});
