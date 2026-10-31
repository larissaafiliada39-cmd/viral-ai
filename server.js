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

let DATA = process.env.DATA_DIR || '/tmp/viral-ai-data';
let VIDEOS = path.join(DATA, 'videos');
let JOBS_FILE = path.join(DATA, 'jobs.json');

const PORT = Number(process.env.PORT || 8000);
const MODEL = process.env.MODEL || 'gemini-omni-1.1-flash';

const app = express();

app.set('trust proxy', 1);

let runtimeGeminiKey = '';

async function prepareStorage() {
  try {
    await fs.mkdir(VIDEOS, { recursive: true });
    await fs.access(DATA);
  } catch (error) {
    console.error(
      'Diretório configurado indisponível:',
      error.message
    );

    DATA = '/tmp/viral-ai-data';
    VIDEOS = path.join(DATA, 'videos');
    JOBS_FILE = path.join(DATA, 'jobs.json');

    await fs.mkdir(VIDEOS, { recursive: true });
  }
}

await prepareStorage();

let jobs = {};

try {
  jobs = JSON.parse(await fs.readFile(JOBS_FILE, 'utf8'));
} catch {
  jobs = {};
}

const persist = async () => {
  await fs.mkdir(DATA, { recursive: true });
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
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false
}));

// STATUS
app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    provider: 'Google Gemini',
    model: MODEL,
    keyConfigured: hasKey(),
    flowBrowserAvailable: true,
    setupUrl: 'https://aistudio.google.com/api-keys'
  });
});

// NAVEGADOR GOOGLE FLOW
let flowBrowser = null;
let flowContext = null;
let flowPage = null;
let flowToken = null;
let flowStarting = false;

function checkFlowToken(req, res, next) {
  const suppliedToken = String(req.headers['x-flow-token'] || '');

  if (!flowToken || suppliedToken !== flowToken) {
    return res.status(401).json({
      ok: false,
      error: 'Sessão não autorizada. Inicie o navegador novamente.'
    });
  }

  next();
}

async function closeFlowSession() {
  const browser = flowBrowser;

  flowBrowser = null;
  flowContext = null;
  flowPage = null;
  flowToken = null;

  if (browser) {
    await browser.close().catch(error => {
      console.error('Erro ao fechar navegador Flow:', error.message);
    });
  }
}

app.post('/api/flow/session/start', async (_req, res) => {
  if (flowStarting) {
    return res.status(409).json({
      ok: false,
      error: 'O navegador está iniciando. Aguarde um momento.'
    });
  }

  if (flowBrowser && flowPage && !flowPage.isClosed()) {
    return res.json({
      ok: true,
      active: true,
      token: flowToken,
      message: 'O navegador já está aberto.'
    });
  }

  flowStarting = true;

  try {
    await closeFlowSession();

    flowBrowser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    flowContext = await flowBrowser.newContext({
      viewport: {
        width: 1365,
        height: 900
      },
      deviceScaleFactor: 1,
      acceptDownloads: true
    });

    flowPage = await flowContext.newPage();
    flowToken = nanoid(40);

    flowPage.setDefaultTimeout(20000);

    try {
      await flowPage.goto('https://labs.google/fx/tools/flow', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    } catch (navigationError) {
      console.error(
        'Aviso ao abrir Google Flow:',
        navigationError.message
      );
    }

    return res.json({
      ok: true,
      active: true,
      token: flowToken,
      message: 'Navegador iniciado. Verifique a tela para continuar.'
    });
  } catch (error) {
    await closeFlowSession();

    console.error('Erro ao iniciar navegador Flow:', error);

    return res.status(500).json({
      ok: false,
      error: String(
        error.message || 'Não foi possível iniciar o navegador.'
      ).slice(0, 700)
    });
  } finally {
    flowStarting = false;
  }
});// STATUS DA SESSÃO FLOW
app.get('/api/flow/session/status', checkFlowToken, (_req, res) => {
  res.json({
    ok: true,
    active: Boolean(
      flowBrowser &&
      flowPage &&
      !flowPage.isClosed()
    ),
    url: flowPage && !flowPage.isClosed()
      ? flowPage.url()
      : null
  });
});

// CAPTURA DA TELA
app.get('/api/flow/session/screen', checkFlowToken, async (_req, res) => {
  try {
    if (!flowPage || flowPage.isClosed()) {
      return res.status(409).json({
        ok: false,
        error: 'O navegador não está aberto.'
      });
    }

    const screenshot = await flowPage.screenshot({
      type: 'jpeg',
      quality: 65,
      fullPage: false
    });

    res.json({
      ok: true,
      image: screenshot.toString('base64'),
      url: flowPage.url(),
      width: 1365,
      height: 900
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || 'Falha ao capturar a tela.').slice(0, 500)
    });
  }
});

// NAVEGAR NO FLOW
app.post('/api/flow/session/navigate', checkFlowToken, async (req, res) => {
  try {
    if (!flowPage || flowPage.isClosed()) {
      return res.status(409).json({
        ok: false,
        error: 'O navegador não está aberto.'
      });
    }

    const address = String(req.body?.url || '').trim();

    let parsedUrl;

    try {
      parsedUrl = new URL(address);
    } catch {
      return res.status(400).json({
        ok: false,
        error: 'Endereço inválido.'
      });
    }

    if (
      parsedUrl.protocol !== 'https:' ||
      ![
        'labs.google',
        'accounts.google.com',
        'www.google.com'
      ].includes(parsedUrl.hostname)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Por segurança, só é permitido acessar páginas do Google.'
      });
    }

    await flowPage.goto(parsedUrl.href, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    res.json({
      ok: true,
      url: flowPage.url()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || 'Falha ao navegar.').slice(0, 500)
    });
  }
});

// CLICAR NA TELA
app.post('/api/flow/session/click', checkFlowToken, async (req, res) => {
  try {
    if (!flowPage || flowPage.isClosed()) {
      return res.status(409).json({
        ok: false,
        error: 'O navegador não está aberto.'
      });
    }

    const x = Number(req.body?.x);
    const y = Number(req.body?.y);

    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x > 1365 ||
      y > 900
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Coordenadas inválidas.'
      });
    }

    await flowPage.mouse.click(x, y);

    res.json({
      ok: true,
      message: 'Clique realizado.'
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || 'Falha ao clicar.').slice(0, 500)
    });
  }
});

// DIGITAR TEXTO
app.post('/api/flow/session/type', checkFlowToken, async (req, res) => {
  try {
    if (!flowPage || flowPage.isClosed()) {
      return res.status(409).json({
        ok: false,
        error: 'O navegador não está aberto.'
      });
    }

    const value = String(req.body?.text || '');

    if (!value || value.length > 12000) {
      return res.status(400).json({
        ok: false,
        error: 'Texto vazio ou muito longo.'
      });
    }

    await flowPage.keyboard.insertText(value);

    res.json({
      ok: true,
      message: 'Texto digitado.'
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || 'Falha ao digitar.').slice(0, 500)
    });
  }
});

// PRESSIONAR TECLAS
app.post('/api/flow/session/key', checkFlowToken, async (req, res) => {
  try {
    if (!flowPage || flowPage.isClosed()) {
      return res.status(409).json({
        ok: false,
        error: 'O navegador não está aberto.'
      });
    }

    const allowedKeys = [
      'Enter',
      'Tab',
      'Escape',
      'Backspace',
      'Delete',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Space'
    ];

    const key = String(req.body?.key || '');

    if (!allowedKeys.includes(key)) {
      return res.status(400).json({
        ok: false,
        error: 'Tecla não permitida.'
      });
    }

    await flowPage.keyboard.press(key);

    res.json({
      ok: true,
      message: 'Tecla pressionada.'
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || 'Falha ao pressionar tecla.').slice(0, 500)
    });
  }
});

// ENCERRAR SESSÃO FLOW
app.post('/api/flow/session/stop', checkFlowToken, async (_req, res) => {
  await closeFlowSession();

  res.json({
    ok: true,
    message: 'Navegador encerrado.'
  });
});

// TESTE DO CHROMIUM
app.get('/api/flow/browser-check', async (_req, res) => {
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

    res.json({
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

    res.status(500).json({
      ok: false,
      error: String(error.message || 'Falha ao iniciar o Chromium').slice(0, 700)
    });
  }
});

// CONFIGURAÇÃO DA CHAVE GEMINI
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

// LISTAR PROJETOS
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

// ABRIR UM PROJETO
app.get('/api/projects/:id', (req, res) => {
  const job = jobs[req.params.id];

  if (!job) {
    return res.status(404).json({
      error: 'Projeto não encontrado.'
    });
  }

  res.json(job);
});

// CRIAR PROJETO
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
});// GERAÇÃO DE VÍDEOS COM GEMINI
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

// INICIAR GERAÇÃO DO PROJETO
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

  if (
    project.status === 'generating' ||
    project.status === 'queued'
  ) {
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

// REGENERAR UMA CENA
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

    if (
      project.status === 'generating' ||
      project.status === 'queued'
    ) {
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

// MONTAGEM DOS VÍDEOS
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

// UNIR CENAS
app.post('/api/projects/:id/merge', async (req, res) => {
  const project = jobs[req.params.id];

  if (!project) {
    return res.status(404).json({
      error: 'Projeto não encontrado.'
    });
  }

  if (
    project.status === 'generating' ||
    project.status === 'queued' ||
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

// DISPONIBILIZAR VÍDEOS
app.use('/media', express.static(VIDEOS));

// PÁGINA PRINCIPAL
app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

// TRATAMENTO DE ERROS
app.use((error, req, res, next) => {
  console.error('Erro no servidor:', error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: 'Erro interno no servidor.'
  });
});

// ENCERRAMENTO DO SERVIDOR
async function shutdown() {
  console.log('Encerrando VIRAL AI...');

  await closeFlowSession();

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// INICIAR SERVIDOR
app.listen(PORT, '0.0.0.0', () => {
  console.log(`VIRAL AI backend ativo na porta ${PORT}`);
});
