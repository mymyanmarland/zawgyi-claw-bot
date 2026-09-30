// AI image generation via an OpenAI-compatible relay (grok-imagine-image models).
// Server-side only: the relay key never leaves the VPS and is never sent to Telegram.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SIZE_MAP = {
  square: '1024x1024',
  portrait: '1024x1536',
  landscape: '1536x1024',
  wide: '1920x1080',
};

function configured() {
  return !!(config.imagineKey && config.imagineBase);
}

function imagineDir(tgId) {
  const d = path.join(config.dataDir, 'imagine', String(tgId || 'shared').replace(/[^0-9a-z]/gi, ''));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function generateImage(prompt, opts = {}) {
  const p = String(prompt || '').trim().slice(0, 1000);
  if (!p) return { error: 'empty_prompt' };
  if (!configured()) return { error: 'not_configured' };
  const model = opts.model || config.imagineModel;
  const size = SIZE_MAP[opts.aspect] || SIZE_MAP.square;
  const base = config.imagineBase.replace(/\/+$/, '');

  let remoteUrl = null;
  try {
    const r = await fetch(base + '/images/generations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.imagineKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, prompt: p, size }),
      signal: AbortSignal.timeout(180000),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* non-JSON */ }
    if (!r.ok) {
      const msg = (data && (data.error && (data.error.message || data.error))) || text.slice(0, 160);
      return { error: 'relay_' + r.status, detail: String(msg).slice(0, 200) };
    }
    const item = data && data.data && data.data[0];
    remoteUrl =
      item && (item.url || (item.b64_json ? 'data:image/png;base64,' + item.b64_json : null));
    if (!remoteUrl) return { error: 'no_image' };
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { error: 'timeout' };
    return { error: 'fetch_failed', detail: String(e.message).slice(0, 160) };
  }

  // Download to a local file so Telegram can send it as a photo.
  try {
    const dir = imagineDir(opts.tgId);
    const name = 'imagine-' + Date.now() + '.jpg';
    const full = path.join(dir, name);
    let buf;
    if (remoteUrl.startsWith('data:')) {
      buf = Buffer.from(remoteUrl.split(',')[1] || '', 'base64');
    } else {
      const r = await fetch(remoteUrl, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) return { error: 'download_failed' };
      buf = Buffer.from(await r.arrayBuffer());
    }
    if (!buf.length || buf.length > 10 * 1024 * 1024) return { error: 'bad_file' };
    fs.writeFileSync(full, buf);
    // prune old images for this user (keep newest 20)
    try {
      const files = fs.readdirSync(dir)
        .filter((f) => f.startsWith('imagine-'))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of files.slice(20)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
      }
    } catch (e) {}
    return { path: full, name, prompt: p };
  } catch (e) {
    return { error: 'download_failed', detail: String(e.message).slice(0, 160) };
  }
}

function translateRelayDetail(detail) {
  // Relay errors often come back in Chinese — translate the common ones.
  let d = String(detail || '');
  const phrases = [
    [/上游服务暂不可用/g, 'upstream ဝန်ဆောင်မှု ခဏမရနိုင်'],
    [/余额不足/g, 'balance မလုံလောက်'],
    [/无效.{0,4}key|key.{0,4}无效/i, 'key မမှန်'],
    [/请求过快|频率限制/g, 'request များလွန်း'],
    [/模型不存在|不支持/g, 'model မရနိုင်'],
  ];
  for (const [re, my] of phrases) d = d.replace(re, my);
  return d.slice(0, 200);
}

function errorText(code, detail) {
  const d = translateRelayDetail(detail);
  switch (code) {
    case 'empty_prompt': return 'ပုံအတွက် ဖော်ပြချက် (prompt) မပါဘူး။';
    case 'not_configured': return 'ပုံထုတ်စနစ် အဆင်သင့်မဖြစ်သေးဘူး (server မှာ relay key မရှိသေးဘူး)။';
    case 'no_image': return 'relay က ပုံ ပြန်မပေးဘူး။ ခဏနေမှ ထပ်စမ်းကြည့်ပါ။';
    case 'timeout': return 'ပုံထုတ်တာ ကြာလွန်းလို့ ရပ်လိုက်ရတယ်။ ခဏနေမှ ထပ်စမ်းကြည့်ပါ။';
    case 'fetch_failed': return 'relay ဆာဗာကို ချိတ်မရဘူး' + (d ? `: ${d}` : '') + '။';
    case 'download_failed': return 'ပုံကို ဒေါင်းလုဒ်ဆွဲမရဘူး။ ခဏနေမှ ထပ်စမ်းကြည့်ပါ။';
    case 'bad_file': return 'ရလာတဲ့ပုံ ဖိုင်မမှန်ဘူး။ ထပ်စမ်းကြည့်ပါ။';
    default:
      if (String(code).startsWith('relay_')) {
        const http = String(code).slice(6);
        if (http === '401') return 'relay key မမှန်ဘူး (သက်တမ်းကုန်နေနိုင်) — server ပြင်ဆင်မှု စစ်ဖို့လိုတယ်။';
        if (http === '402' || http === '403') return 'relay balance ကုန်နေနိုင် / ခွင့်ပြုချက်မရှိဘူး' + (d ? `: ${d}` : '') + '။';
        if (http === '429') return 'ခဏတာ request များနေတယ် — ခနစောင့်ပြီး ထပ်စမ်းကြည့်ပါ။';
        if (['500', '502', '503', '504'].includes(http)) {
          if (/upstream/i.test(d)) {
            return 'relay ဘက်က ပုံထုတ်ဝန်ဆောင်မှု ခဏရပ်နေတယ် — မင်းဘက်က အမှားမဟုတ်ဘူး။ မိနစ်အနည်းငယ်စောင့်ပြီး ထပ်စမ်းကြည့်ပါ 🙏';
          }
          return `relay server ခဏအမှားရှိနေတယ် (HTTP ${http}) — ခဏနေမှ ထပ်စမ်းကြည့်ပါ။`;
        }
        return `relay error (HTTP ${http})` + (d ? `: ${d}` : '') + '။';
      }
      return 'ပုံထုတ်မရဘူး 😅 ခဏနေမှ ထပ်စမ်းကြည့်ပါ။';
  }
}

module.exports = { generateImage, configured, errorText, SIZE_MAP };
