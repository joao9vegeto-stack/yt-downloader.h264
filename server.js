const express = require("express");
const cors = require("cors");
const ytdlp = require("yt-dlp-exec");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// No-cache for HTML so updates are always picked up
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
app.use(express.static("public"));

const ytdlpBin = path.join(__dirname, "node_modules", "yt-dlp-exec", "bin", "yt-dlp");
const TIERS = [1080, 720];
const jobs = {};
const COOKIES_FILE = path.join(os.tmpdir(), "yt_cookies.txt");

// ─── Startup: clean leftover temp files ──────────────────────────────────────
try {
  fs.readdirSync(os.tmpdir())
    .filter(f => f.startsWith("ytdl_"))
    .forEach(f => fs.unlinkSync(path.join(os.tmpdir(), f)));
} catch (_) {}

// ─── Startup: auto-update yt-dlp in background ───────────────────────────────
const upd = spawn(ytdlpBin, ["-U"]);
upd.stdout.on("data", d => process.stdout.write("[yt-dlp update] " + d));
upd.stderr.on("data", d => process.stdout.write("[yt-dlp update] " + d));
upd.on("close", code => console.log(`[yt-dlp update] concluído (code ${code})`));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function hmsToSec(hms) {
  if (!hms) return 0;
  const [h, m, s] = hms.split(":").map(parseFloat);
  return h * 3600 + m * 60 + s;
}

function fmtEta(secs) {
  if (!secs || secs <= 0) return null;
  if (secs < 60) return `~${Math.round(secs)}s restantes`;
  return `~${Math.round(secs / 60)}min restantes`;
}

// Delete only the raw (pre-encode) temp file — outFile is kept until new job
function cleanRaw(job) {
  if (job && job.rawFile) fs.unlink(job.rawFile, () => {});
}

// Full cleanup: raw + out + job entry
function cleanJob(id) {
  const job = jobs[id];
  if (!job) return;
  cleanRaw(job);
  if (job.outFile) fs.unlink(job.outFile, () => {});
  delete jobs[id];
}

// Delete all previous ready/error jobs to free disk before starting a new one
function cleanOldJobs() {
  Object.keys(jobs).forEach(id => {
    const j = jobs[id];
    if (j.status === "ready" || j.status === "error") cleanJob(id);
  });
}

function hasCookies() {
  try { return fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100; }
  catch (_) { return false; }
}

function ytdlpArgs(extra = []) {
  const base = [...extra];
  if (hasCookies()) {
    base.push("--cookies", COOKIES_FILE);
    console.log("[yt-dlp] usando cookies");
  }
  return base;
}

// Auto-clean jobs stuck in downloading/encoding after 20 min; keep ready jobs up to 4 h
setInterval(() => {
  const now = Date.now();
  Object.keys(jobs).forEach(id => {
    const j = jobs[id];
    const age = now - Number(id);
    if (j.status === "ready" && age > 4 * 60 * 60 * 1000) cleanJob(id);
    if (j.status !== "ready" && age > 20 * 60 * 1000) cleanJob(id);
  });
}, 2 * 60 * 1000);

// ─── POST /cookies ────────────────────────────────────────────────────────────
app.post("/cookies", (req, res) => {
  const { content } = req.body;
  if (!content || content.trim().length < 50) {
    return res.status(400).json({ error: "Conteúdo de cookies inválido" });
  }
  try {
    fs.writeFileSync(COOKIES_FILE, content.trim(), "utf8");
    console.log(`[cookies] salvo (${(content.length / 1024).toFixed(1)} KB)`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erro ao salvar cookies" });
  }
});

// ─── GET /cookies-status ──────────────────────────────────────────────────────
app.get("/cookies-status", (req, res) => {
  res.json({ configured: hasCookies() });
});

// ─── POST /video ──────────────────────────────────────────────────────────────
app.post("/video", async (req, res) => {
  try {
    const { url } = req.body;
    const args = { dumpSingleJson: true };
    if (hasCookies()) args.cookies = COOKIES_FILE;

    const info = await ytdlp(url, args);

    const videoFormats = info.formats.filter(f => f.vcodec && f.vcodec !== "none" && f.height);
    const baseName = info.title.replace(/[^a-z0-9]/gi, "_");
    const qualities = [];

    for (const tier of TIERS) {
      if (videoFormats.some(f => f.height >= tier * 0.94)) {
        qualities.push({ height: tier, codec: "h264", filename: `${baseName}_${tier}p_H264.mp4` });
        qualities.push({ height: tier, codec: "prores", filename: `${baseName}_${tier}p_ProRes.mov` });
      }
    }

    res.json({ title: info.title, thumbnail: info.thumbnail, videoUrl: url, qualities });
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar vídeo: " + e.message });
  }
});

// ─── POST /prepare ────────────────────────────────────────────────────────────
app.post("/prepare", (req, res) => {
  const { url, height, codec, filename } = req.body;
  if (!url || !height) return res.status(400).json({ error: "Parâmetros inválidos" });

  // Free disk: delete all previous ready/error jobs before starting new one
  cleanOldJobs();

  const id = String(Date.now());
  const isProRes = codec === "prores";
  const ext = isProRes ? "mov" : "mp4";
  const safeFilename = (filename || `video_${height}p.${ext}`).replace(/[^a-z0-9._-]/gi, "_");
  const rawFile = path.join(os.tmpdir(), `ytdl_raw_${id}.mp4`);
  const outFile = path.join(os.tmpdir(), `ytdl_out_${id}.${ext}`);

  jobs[id] = {
    status: "downloading", message: "Baixando vídeo…",
    progress: 0, eta: null,
    rawFile, outFile, safeFilename, ext
  };

  res.json({ jobId: id });

  const formatStr = [
    `bestvideo[height<=${height}][vcodec^=avc1]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${height}][vcodec^=avc]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${height}]+bestaudio`,
    `best[height<=${height}]`
  ].join("/");
  console.log(`[${id}] ${height}p ${isProRes ? "ProRes" : "H264"}…`);

  // ── Step 1: download ──────────────────────────────────────────────────────
  const nodeBin = process.execPath;
  const dlArgs = ytdlpArgs([
    "-f", formatStr,
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--js-runtimes", `node:${nodeBin}`,
    "--newline",
    "--progress",
    "-o", rawFile,
    url
  ]);

  const dl = spawn(ytdlpBin, dlArgs);

  const dlTimeout = setTimeout(() => {
    dl.kill("SIGKILL");
    if (jobs[id]) Object.assign(jobs[id], { status: "error", message: "Download expirou (timeout 15min)" });
  }, 15 * 60 * 1000);

  // yt-dlp writes ALL output (including progress) to STDOUT
  let dlBuf = "";
  const parseDlChunk = (chunk) => {
    dlBuf += chunk.toString();
    const lines = dlBuf.split(/[\r\n]/);
    dlBuf = lines.pop();
    for (const line of lines) {
      if (line.trim()) process.stdout.write(line + "\n");
      const pctM  = line.match(/\[download\]\s+([\d.]+)%/);
      const rateM = line.match(/at\s+([\d.]+\s*[KMGk]iB\/s)/);
      const etaM  = line.match(/ETA\s+(\d+:\d+)/);
      if (pctM && jobs[id] && jobs[id].status === "downloading") {
        const dlPct = parseFloat(pctM[1]);
        jobs[id].progress = Math.round(dlPct * 0.4);
        const rate = rateM ? ` · ${rateM[1]}` : "";
        const eta  = etaM  ? ` · ETA ${etaM[1]}` : "";
        jobs[id].message = `Baixando… ${dlPct.toFixed(1)}%${rate}${eta}`;
      }
    }
  };
  dl.stdout.on("data", parseDlChunk);
  dl.stderr.on("data", parseDlChunk);

  dl.on("close", code => {
    clearTimeout(dlTimeout);
    if (code !== 0 || !fs.existsSync(rawFile)) {
      if (jobs[id]) Object.assign(jobs[id], { status: "error", message: "Falha no download do vídeo" });
      return;
    }

    if (jobs[id]) Object.assign(jobs[id], {
      message: isProRes ? "Convertendo para ProRes…" : "Convertendo para H264…",
      progress: 40
    });

    // ── Step 2: encode ────────────────────────────────────────────────────
    const ffArgs = isProRes
      ? ["-y", "-threads", "0", "-i", rawFile,
         "-c:v", "prores_aw", "-profile:v", "2", "-pix_fmt", "yuv422p10le",
         "-c:a", "pcm_s16le", outFile]
      : ["-y", "-threads", "0", "-i", rawFile,
         "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "high", "-level", "4.2",
         "-pix_fmt", "yuv420p", "-vf", "fps=30",
         "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
         "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outFile];

    const ff = spawn("ffmpeg", ffArgs);
    let totalSec = 0;
    let encodeStart = Date.now();
    let lastPct = 40;

    ff.stderr.on("data", chunk => {
      const text = chunk.toString();
      if (!totalSec) {
        const dm = text.match(/Duration:\s*(\d+:\d+:\d+\.\d+)/);
        if (dm) totalSec = hmsToSec(dm[1]);
      }
      const tm = text.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (tm && totalSec > 0) {
        const doneSec = hmsToSec(tm[1]);
        const pct = Math.min(95, 40 + Math.round((doneSec / totalSec) * 55));
        const elapsed = (Date.now() - encodeStart) / 1000;
        const rate = doneSec / elapsed;
        const remaining = rate > 0 ? (totalSec - doneSec) / rate : null;
        if (pct > lastPct) {
          lastPct = pct;
          if (jobs[id]) {
            jobs[id].progress = pct;
            jobs[id].eta = fmtEta(remaining);
            jobs[id].message = `${isProRes ? "ProRes" : "H264"} ${pct}%${remaining ? " — " + fmtEta(remaining) : ""}`;
          }
        }
      }
    });

    ff.on("close", code2 => {
      // Raw file no longer needed — delete immediately to free disk
      fs.unlink(rawFile, () => {});
      if (code2 !== 0 || !fs.existsSync(outFile)) {
        console.error(`[${id}] ffmpeg falhou (code ${code2})`);
        if (jobs[id]) Object.assign(jobs[id], { status: "error", message: "Falha na conversão" });
        return;
      }
      const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
      console.log(`[${id}] Pronto: ${size} MB`);
      if (jobs[id]) Object.assign(jobs[id], {
        status: "ready", progress: 100,
        message: `Pronto — ${size} MB`, eta: null,
        sizeMB: size
      });
    });

    ff.on("error", err => {
      console.error(`[${id}] ffmpeg error:`, err.message);
      if (jobs[id]) Object.assign(jobs[id], { status: "error", message: "ffmpeg não encontrado" });
    });
  });

  dl.on("error", () => {
    if (jobs[id]) Object.assign(jobs[id], { status: "error", message: "Falha ao iniciar download" });
  });
});

// ─── GET /status ──────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  const job = jobs[req.query.id];
  if (!job) return res.status(404).json({ error: "Job expirado ou não encontrado" });
  res.json({
    status: job.status,
    message: job.message,
    progress: job.progress || 0,
    eta: job.eta,
    sizeMB: job.sizeMB || null
  });
});

// ─── GET /file ────────────────────────────────────────────────────────────────
// Uses res.sendFile which supports Accept-Ranges (resumable, parallel chunks)
// The file is NOT deleted after download — stays available until next /prepare call
app.get("/file", (req, res) => {
  const { id } = req.query;
  const job = jobs[id];
  if (!job || job.status !== "ready") return res.status(404).json({ error: "Arquivo não disponível" });
  if (!fs.existsSync(job.outFile)) return res.status(410).json({ error: "Arquivo expirado, processe novamente" });

  const mimeType = job.ext === "mov" ? "video/quicktime" : "video/mp4";
  res.setHeader("Content-Disposition", `attachment; filename="${job.safeFilename}"`);
  res.setHeader("Content-Type", mimeType);

  // sendFile handles Content-Length, Accept-Ranges, ETag, 206 Partial Content automatically
  res.sendFile(job.outFile, { acceptRanges: true }, err => {
    if (err && !res.headersSent) {
      console.error(`[${id}] Erro ao enviar arquivo:`, err.message);
      res.status(500).json({ error: "Erro ao enviar arquivo" });
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor online"));
