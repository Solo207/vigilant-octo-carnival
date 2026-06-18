// npm install cookie-parser  ← run once if not already installed
const express      = require('express');
const cookieParser = require('cookie-parser');
const { randomUUID: uuidv4 } = require('crypto');
const fs   = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ── Config ────────────────────────────────────────────────────────────────────
const STORE_FILE = path.join(__dirname, 'quiz-review.json');
const TTL_MS      = 6 * 60 * 60 * 1000; // 6 hours
// No WEBHOOK_URL — this app never sends results anywhere.

// ── Atomic write queue ────────────────────────────────────────────────────────
let storeWriteQueue = Promise.resolve();
function loadStore() {
  try { if (fs.existsSync(STORE_FILE)) return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch (e) { console.error('loadStore error:', e); }
  return {};
}
function saveStore(store) {
  storeWriteQueue = storeWriteQueue.then(() => {
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
  }).catch(err => console.error('saveStore error:', err));
}
function cleanup(store) {
  const now = Date.now(); let changed = false;
  for (const id in store) { if (now > store[id].expiresAt) { delete store[id]; changed = true; } }
  if (changed) saveStore(store);
  return store;
}

// ── Periodic cleanup every 30 min ─────────────────────────────────────────────
setInterval(() => {
  const store = loadStore();
  const before = Object.keys(store).length;
  cleanup(store);
  const after = Object.keys(store).length;
  if (before !== after) console.log(`Periodic cleanup: removed ${before - after} expired quiz(zes)`);
}, 30 * 60 * 1000);

function setSessionCookie(res, quizId, token) {
  res.cookie('qsess_' + quizId, token, { maxAge: TTL_MS, httpOnly: false, sameSite: 'lax' });
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/create-quiz', (req, res) => {
  const { title, question } = req.body;
  if (!title || !question) return res.status(400).json({ error: 'Missing title or question fields' });
  let questions;
  try { questions = typeof question === 'string' ? JSON.parse(question) : question; }
  catch (e) { return res.status(400).json({ error: 'Invalid questions JSON' }); }
  const id    = uuidv4();
  const store = cleanup(loadStore());
  store[id] = { title, questions, createdAt: Date.now(), expiresAt: Date.now() + TTL_MS, claimed: false };
  saveStore(store);
  const host     = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  res.json({ link: `${protocol}://${host}/quiz/${id}`, id, expiresIn: '6 hours' });
});

app.get('/quiz/:id', (req, res) => {
  const store = cleanup(loadStore());
  const quiz  = store[req.params.id];
  if (!quiz) return res.status(404).send(expiredPage());
  const cookieName    = 'qsess_' + req.params.id;
  const sessionCookie = req.cookies?.[cookieName];
  if (!quiz.claimed) {
    const token = uuidv4();
    store[req.params.id].claimed = true; store[req.params.id].sessionToken = token;
    saveStore(store); setSessionCookie(res, req.params.id, token);
    return res.send(quizPage(req.params.id, store[req.params.id]));
  }
  if (sessionCookie === quiz.sessionToken) return res.send(quizPage(req.params.id, quiz));
  return res.status(403).send(claimedPage(req.params.id));
});

app.post('/quiz/:id/recover', (req, res) => {
  const store = loadStore(), quiz = store[req.params.id];
  if (!quiz) return res.status(404).json({ ok: false });
  const { token } = req.body;
  if (!token || token !== quiz.sessionToken) return res.status(403).json({ ok: false, error: 'Invalid token' });
  setSessionCookie(res, req.params.id, quiz.sessionToken);
  res.json({ ok: true });
});

// No /submit endpoint — scoring is fully client-side, nothing to forward.
// No DELETE-on-submit either — quiz persists until natural expiry so the
// user can refresh and still review their marked answers.

app.delete('/quiz/:id', (req, res) => {
  // Still exposed for manual cleanup if ever needed, but the client never calls
  // this automatically in the review-only flow.
  const store = loadStore(), quiz = store[req.params.id];
  if (!quiz) return res.json({ ok: true });
  const cookieName = 'qsess_' + req.params.id;
  if (req.cookies?.[cookieName] !== quiz.sessionToken) return res.status(403).json({ ok: false, error: 'Unauthorized' });
  delete store[req.params.id]; saveStore(store); res.json({ ok: true });
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Quiz Review App' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quiz review app running on port ${PORT}`));

// ── Static pages ──────────────────────────────────────────────────────────────
function expiredPage() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Quiz Expired</title>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600&display=swap" rel="stylesheet"/>
  <style>body{background:#090b18;color:#fff;font-family:'Sora',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
  .box{text-align:center;}h1{font-size:2.5rem;color:#ef4444;margin-bottom:12px;}p{color:#64748b;}</style>
  </head><body><div class="box"><h1>⏳ Quiz Expired</h1><p>This quiz link has expired.</p></div></body></html>`;
}

function claimedPage(quizId) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reconnecting…</title>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    body{background:#090b18;color:#fff;font-family:'Sora',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px;}
    .box{text-align:center;max-width:400px;}h1{font-size:2rem;margin-bottom:12px;}p{color:#64748b;line-height:1.6;font-size:.9rem;}
    .spinner{width:36px;height:36px;border:3px solid #1e2d45;border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite;margin:20px auto;}
    @keyframes spin{to{transform:rotate(360deg);}}.error{color:#ef4444;}
  </style></head><body>
  <div class="box">
    <div id="checking"><h1 style="color:#f59e0b">🔒 Reconnecting…</h1><p>Verifying your session…</p><div class="spinner"></div></div>
    <div id="error" style="display:none"><h1 class="error">Quiz Unavailable</h1><p>This quiz is already in use by another session.</p></div>
  </div>
  <script>
    (function(){
      var tok=localStorage.getItem('qt_${quizId}');
      if(!tok){showError();return;}
      fetch('/quiz/${quizId}/recover',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({token:tok})})
      .then(function(r){if(r.ok){location.href='/quiz/${quizId}';}else{showError();}}).catch(showError);
      function showError(){document.getElementById('checking').style.display='none';document.getElementById('error').style.display='block';}
    })();
  </script></body></html>`;
}

// ── Quiz page ─────────────────────────────────────────────────────────────────
function quizPage(id, quiz) {
  const questionsJson = JSON.stringify(quiz.questions);
  const titleJson     = JSON.stringify(quiz.title);
  const tokenJson     = JSON.stringify(quiz.sessionToken);
  const FAVICON = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%23090b18'/><circle cx='16' cy='16' r='10' fill='none' stroke='%233b82f6' stroke-width='2'/><polyline points='11,16 14.5,20 21,12' fill='none' stroke='%2322c55e' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/></svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${quiz.title}</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON}"/>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    :root{
      --bg:#090b18;--surface:#0d1626;--surface2:#121d30;--border:#1e2d45;
      --accent:#3b82f6;--accent2:#60a5fa;--correct:#22c55e;--wrong:#ef4444;
      --bookmark:#f59e0b;--text:#e2e8f0;--muted:#64748b;
      --mono:'JetBrains Mono',monospace;
    }
    body{background:var(--bg);color:var(--text);font-family:'Sora',sans-serif;min-height:100vh;overflow-x:hidden;}
    #bgCanvas{position:fixed;inset:0;z-index:0;pointer-events:none;}
    .bg-grid{position:fixed;inset:0;z-index:0;pointer-events:none;
      background-image:linear-gradient(rgba(99,102,241,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,.06) 1px,transparent 1px);
      background-size:44px 44px;animation:gridPulse 5s ease-in-out infinite;}
    @keyframes gridPulse{0%,100%{opacity:.45;}50%{opacity:1;}}
    .bg-orb{position:fixed;border-radius:50%;pointer-events:none;z-index:0;filter:blur(80px);}
    .bg-orb-1{width:560px;height:560px;top:-160px;right:-120px;background:radial-gradient(circle,rgba(99,102,241,.2) 0%,transparent 70%);animation:orbFloat 9s ease-in-out infinite;}
    .bg-orb-2{width:440px;height:440px;bottom:5%;left:-120px;background:radial-gradient(circle,rgba(20,184,166,.16) 0%,transparent 70%);animation:orbFloat 11s ease-in-out infinite reverse;}
    .bg-orb-3{width:340px;height:340px;bottom:-60px;right:8%;background:radial-gradient(circle,rgba(245,158,11,.14) 0%,transparent 70%);animation:orbFloat 14s ease-in-out infinite 2s;}
    .bg-orb-4{width:380px;height:380px;top:-80px;left:-100px;background:radial-gradient(circle,rgba(168,85,247,.16) 0%,transparent 70%);animation:orbFloat 12s ease-in-out infinite 4s;}
    @keyframes orbFloat{0%,100%{transform:translateY(0) scale(1);}50%{transform:translateY(-32px) scale(1.05);}}

    .container{max-width:680px;margin:0 auto;padding:24px 16px 200px;position:relative;z-index:1;}

    .header{display:flex;align-items:center;justify-content:space-between;
      margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:10px;}
    .title{font-family:var(--mono);font-size:.75rem;color:var(--accent);letter-spacing:.12em;text-transform:uppercase;}
    .review-badge{display:none;font-family:var(--mono);font-size:.68rem;color:var(--bookmark);
      letter-spacing:.1em;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);
      padding:4px 10px;border-radius:20px;}
    .review-badge.show{display:inline-block;animation:fadeIn .25s ease;}

    .progress-wrap{margin-bottom:28px;}
    .progress-label{display:flex;justify-content:space-between;font-size:.75rem;color:var(--muted);font-family:var(--mono);margin-bottom:8px;}
    .progress-bar{height:3px;background:var(--border);border-radius:2px;overflow:hidden;}
    .progress-fill{height:100%;background:linear-gradient(90deg,var(--accent),#a855f7);border-radius:2px;transition:width .5s cubic-bezier(.4,0,.2,1);}

    .question-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px;margin-bottom:16px;}
    .q-number{font-family:var(--mono);font-size:.7rem;color:var(--accent);letter-spacing:.1em;margin-bottom:12px;}
    .q-text{font-size:1.05rem;font-weight:400;line-height:1.65;color:var(--text);}
    @keyframes slideIn{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}
    @keyframes fadeIn{from{opacity:0;}to{opacity:1;}}

    .options{display:flex;flex-direction:column;gap:10px;margin-top:24px;}
    .option{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:14px 18px;
      cursor:pointer;display:flex;align-items:center;gap:12px;transition:all .18s;font-size:.92rem;color:var(--text);text-align:left;width:100%;}
    .option:hover:not(.disabled){border-color:var(--accent);background:rgba(59,130,246,.06);}
    .option.disabled{cursor:default;pointer-events:none;}
    .option.correct{border-color:var(--correct);background:rgba(34,197,94,.08);color:var(--correct);}
    .option.wrong{border-color:var(--wrong);background:rgba(239,68,68,.08);color:var(--wrong);}
    .opt-letter{font-family:var(--mono);font-size:.72rem;font-weight:600;width:26px;height:26px;border-radius:6px;
      background:var(--border);color:var(--muted);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .18s;}
    .option.correct .opt-letter{background:var(--correct);color:#fff;}
    .option.wrong .opt-letter{background:var(--wrong);color:#fff;}

    .feedback{margin-top:16px;padding:14px 18px;border-radius:10px;font-size:.88rem;line-height:1.6;display:none;}
    .feedback.show{display:block;animation:fadeIn .25s ease;}
    .feedback.correct-fb{background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);color:#86efac;}
    .feedback.wrong-fb{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.2);color:#fca5a5;}
    .feedback.skipped-fb{background:rgba(100,116,139,.08);border:1px solid rgba(100,116,139,.25);color:var(--muted);}

    .change-answer-wrap{display:none;margin-top:10px;}
    .change-answer-wrap.show{display:block;animation:fadeIn .25s ease;}
    .change-answer-btn{background:none;border:1px dashed var(--accent);color:var(--accent2);padding:8px 16px;
      border-radius:8px;font-family:'Sora',sans-serif;font-size:.8rem;cursor:pointer;transition:all .2s;}
    .change-answer-btn:hover{background:rgba(59,130,246,.07);}

    .nav{display:flex;gap:10px;margin-top:20px;}
    .btn{padding:14px;border-radius:12px;border:none;font-family:'Sora',sans-serif;font-size:.9rem;font-weight:600;cursor:pointer;transition:all .2s;}
    .btn-prev{background:var(--surface2);border:1px solid var(--border);color:var(--muted);flex:0 0 auto;min-width:96px;}
    .btn-prev:hover:not(:disabled){border-color:var(--accent);color:var(--text);}
    .btn-prev:disabled{opacity:.3;cursor:not-allowed;}
    .btn-next{background:linear-gradient(135deg,var(--accent),#7c3aed);color:#fff;flex:1;}
    .btn-next:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(99,102,241,.35);}
    .btn-next.skip-mode{background:var(--surface2);border:1px solid var(--border);color:var(--muted);}
    .btn-next.skip-mode:hover{border-color:var(--accent);color:var(--text);transform:none;box-shadow:none;}

    .back-to-results-wrap{display:none;margin-top:10px;}
    .back-to-results-wrap.show{display:block;}
    .back-to-results-btn{background:var(--surface);border:1px solid var(--border);color:var(--muted);
      padding:12px 18px;border-radius:10px;font-family:'Sora',sans-serif;font-size:.85rem;cursor:pointer;
      transition:all .2s;width:100%;}
    .back-to-results-btn:hover{border-color:var(--accent);color:var(--text);}

    .qnav-wrap{margin-top:10px;}
    .qnav-toggle-btn{background:var(--surface);border:1px solid var(--border);color:var(--muted);
      padding:10px 18px;border-radius:10px;font-family:'Sora',sans-serif;font-size:.82rem;cursor:pointer;
      transition:all .2s;display:flex;align-items:center;gap:8px;width:100%;justify-content:center;}
    .qnav-toggle-btn:hover{border-color:var(--accent);color:var(--text);}
    .qnav-toggle-btn.active{border-color:var(--accent);color:var(--accent2);background:rgba(59,130,246,.05);}
    .qnav-panel{display:none;margin-top:10px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;}
    .qnav-panel.show{display:block;animation:fadeIn .25s ease;}
    .qnav-label{font-family:var(--mono);font-size:.7rem;color:var(--muted);letter-spacing:.1em;margin-bottom:10px;}
    .qnav-legend{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;}
    .qnav-legend-item{display:flex;align-items:center;gap:5px;font-size:.7rem;color:var(--muted);}
    .qnav-dot{width:10px;height:10px;border-radius:3px;}
    .qnav-dot.d-current{background:rgba(59,130,246,.6);} .qnav-dot.d-correct{background:rgba(34,197,94,.6);}
    .qnav-dot.d-wrong{background:rgba(239,68,68,.6);} .qnav-dot.d-unanswered{background:var(--border);}
    .qnav-grid{display:flex;flex-wrap:wrap;gap:8px;}
    .qnav-chip{width:40px;height:40px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);
      color:var(--muted);font-family:var(--mono);font-size:.8rem;font-weight:600;cursor:pointer;
      display:flex;align-items:center;justify-content:center;transition:all .15s;position:relative;}
    .qnav-chip:hover{border-color:var(--accent);color:var(--text);}
    .qnav-chip.qn-current{border-color:var(--accent);color:var(--accent);background:rgba(59,130,246,.12);}
    .qnav-chip.qn-correct{border-color:var(--correct);background:rgba(34,197,94,.1);color:var(--correct);}
    .qnav-chip.qn-wrong{border-color:var(--wrong);background:rgba(239,68,68,.1);color:var(--wrong);}

    .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:100;
      display:none;align-items:center;justify-content:center;padding:20px;}
    .modal-overlay.show{display:flex;animation:fadeIn .2s ease;}
    .modal-box{background:var(--surface);border:1px solid var(--border);border-radius:18px;
      padding:32px 28px;max-width:400px;width:100%;text-align:center;animation:slideIn .3s cubic-bezier(.4,0,.2,1);}
    .modal-icon{font-size:2.5rem;margin-bottom:14px;}
    .modal-title{font-size:1.2rem;font-weight:600;color:var(--text);margin-bottom:10px;}
    .modal-msg{font-size:.9rem;color:var(--muted);line-height:1.6;margin-bottom:24px;}
    .modal-btns{display:flex;gap:12px;}
    .modal-btn-cancel{flex:1;padding:13px;border-radius:11px;background:var(--surface2);border:1px solid var(--border);
      color:var(--muted);font-family:'Sora',sans-serif;font-size:.9rem;font-weight:600;cursor:pointer;transition:all .2s;}
    .modal-btn-cancel:hover{border-color:var(--accent);color:var(--text);}
    .modal-btn-confirm{flex:1;padding:13px;border-radius:11px;background:linear-gradient(135deg,var(--accent),#7c3aed);
      color:#fff;border:none;font-family:'Sora',sans-serif;font-size:.9rem;font-weight:600;cursor:pointer;transition:all .2s;}
    .modal-btn-confirm:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(99,102,241,.35);}

    .results-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;
      padding:36px 28px;text-align:center;display:none;}
    .results-card.show{display:block;animation:slideIn .4s cubic-bezier(.4,0,.2,1);}
    .score-big{font-family:var(--mono);font-size:3.5rem;font-weight:600;
      background:linear-gradient(135deg,var(--accent),#a855f7);
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px;}
    .score-percent{font-family:var(--mono);font-size:1.6rem;font-weight:600;color:var(--accent2);margin-bottom:4px;}
    .score-label{color:var(--muted);font-size:.88rem;margin-bottom:28px;}
    .stats{display:flex;gap:12px;justify-content:center;margin-bottom:28px;flex-wrap:wrap;}
    .stat{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px 18px;text-align:center;min-width:76px;}
    .stat-val{font-family:var(--mono);font-size:1.4rem;font-weight:600;}
    .stat-val.c{color:var(--correct);} .stat-val.w{color:var(--wrong);} .stat-val.s{color:var(--muted);}
    .stat-label{font-size:.7rem;color:var(--muted);margin-top:2px;letter-spacing:.05em;}
    .review-btn{background:linear-gradient(135deg,var(--accent),#7c3aed);color:#fff;border:none;
      padding:14px 28px;border-radius:12px;font-family:'Sora',sans-serif;font-size:.9rem;font-weight:600;
      cursor:pointer;transition:all .2s;width:100%;}
    .review-btn:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(99,102,241,.35);}
    .results-note{font-size:.78rem;color:var(--muted);margin-top:14px;line-height:1.5;}

    @media(max-width:520px){
      .container{padding:16px 12px 200px;}
      .q-text{font-size:.95rem;} .question-card{padding:20px 16px;} .option{font-size:.86rem;padding:12px 14px;}
      .score-big{font-size:2.5rem;} .score-percent{font-size:1.3rem;}
      .stat{padding:10px 12px;min-width:66px;} .stat-val{font-size:1.1rem;}
      .qnav-chip{width:36px;height:36px;font-size:.75rem;}
      .btn{font-size:.85rem;padding:13px;} .btn-prev{min-width:80px;} .modal-box{padding:24px 18px;}
    }
    @media(max-width:360px){.qnav-chip{width:32px;height:32px;font-size:.7rem;}}
  </style>
</head>
<body>
<canvas id="bgCanvas"></canvas>
<div class="bg-grid"></div>
<div class="bg-orb bg-orb-1"></div><div class="bg-orb bg-orb-2"></div>
<div class="bg-orb bg-orb-3"></div><div class="bg-orb bg-orb-4"></div>

<div class="container">
  <div class="header">
    <div class="title" id="quizTitle"></div>
    <div class="review-badge" id="reviewBadge">📖 REVIEW MODE</div>
  </div>

  <div class="progress-wrap">
    <div class="progress-label"><span id="qProgress">Question 1</span><span id="qFraction">1 / 0</span></div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
  </div>

  <div class="question-card" id="questionCard">
    <div class="q-number" id="qNum"></div>
    <div class="q-text" id="qText"></div>
    <div class="options" id="options"></div>
    <div class="feedback" id="feedback"></div>
    <div class="change-answer-wrap" id="changeAnswerWrap">
      <button class="change-answer-btn" onclick="changeAnswer()">↩ Change Answer</button>
    </div>
  </div>

  <div class="nav" id="navRow">
    <button class="btn btn-prev" id="prevBtn" onclick="prevQuestion()" disabled>← Prev</button>
    <button class="btn btn-next skip-mode" id="nextBtn" onclick="nextQuestion()">Next →</button>
  </div>

  <div class="back-to-results-wrap" id="backToResultsWrap">
    <button class="back-to-results-btn" onclick="backToResults()">← Back to Results</button>
  </div>

  <div class="qnav-wrap">
    <button class="qnav-toggle-btn" id="qnavToggleBtn" onclick="toggleQNav()">⊞ &nbsp;All Questions</button>
    <div class="qnav-panel" id="qnavPanel">
      <div class="qnav-label">TAP A NUMBER TO JUMP</div>
      <div class="qnav-legend">
        <div class="qnav-legend-item"><div class="qnav-dot d-current"></div>Current</div>
        <div class="qnav-legend-item"><div class="qnav-dot d-correct"></div>Correct</div>
        <div class="qnav-legend-item"><div class="qnav-dot d-wrong"></div>Wrong</div>
        <div class="qnav-legend-item"><div class="qnav-dot d-unanswered"></div>Unanswered</div>
      </div>
      <div class="qnav-grid" id="qnavGrid"></div>
    </div>
  </div>

  <div class="results-card" id="resultsCard">
    <div class="score-big" id="scoreBig"></div>
    <div class="score-percent" id="scorePercent"></div>
    <div class="score-label">Final Score</div>
    <div class="stats">
      <div class="stat"><div class="stat-val c" id="statCorrect">0</div><div class="stat-label">CORRECT</div></div>
      <div class="stat"><div class="stat-val w" id="statWrong">0</div><div class="stat-label">WRONG</div></div>
      <div class="stat"><div class="stat-val s" id="statSkipped">0</div><div class="stat-label">SKIPPED</div></div>
    </div>
    <button class="review-btn" onclick="enterReview()">📖 Review Answers</button>
    <div class="results-note">You can revisit this page to review your answers until the link expires.</div>
  </div>
</div>

<div class="modal-overlay" id="submitModal">
  <div class="modal-box">
    <div class="modal-icon">🎯</div>
    <div class="modal-title">Submit Quiz?</div>
    <p class="modal-msg" id="modalMsg"></p>
    <div class="modal-btns">
      <button class="modal-btn-cancel" onclick="closeModal()">Go Back</button>
      <button class="modal-btn-confirm" onclick="confirmSubmit()">Submit Anyway</button>
    </div>
  </div>
</div>

<script>
const QUIZ_ID    = ${JSON.stringify(id)};
const TITLE      = ${titleJson};
const QUESTIONS  = ${questionsJson};
const SESS_TOKEN = ${tokenJson};

localStorage.setItem('qt_' + QUIZ_ID, SESS_TOKEN);

// ── State ─────────────────────────────────────────────────────────────────────
let current   = 0;
let answered  = false;
let results   = [];      // { number, correct, selectedLetter, skipped? }
let submitted = false;   // becomes true once user has submitted
let reviewing = false;   // true while browsing answers post-submit
const LETTERS = ['a','b','c','d','e'];

// ── Persistence ───────────────────────────────────────────────────────────────
const STATE_KEY = 'quizreview_state_' + QUIZ_ID;
function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ current, results, submitted })); } catch(e) {}
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    if (!s) return;
    current   = typeof s.current === 'number' ? s.current : 0;
    results   = Array.isArray(s.results) ? s.results : [];
    submitted = !!s.submitted;
  } catch(e) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getOptions(q) {
  return LETTERS.map(l => ({ letter: l.toUpperCase(), text: q['option_' + l] })).filter(o => o.text?.trim());
}

// ── Render (handles both active quiz-taking and locked review mode) ──────────
function render() {
  const q = QUESTIONS[current], total = QUESTIONS.length, isLast = current === total - 1;
  const prevResult = results.find(r => r.number === q.number);
  const locked = submitted; // once submitted, every question is permanently locked

  document.getElementById('quizTitle').textContent = TITLE;
  document.getElementById('qNum').textContent       = 'QUESTION ' + q.number;
  document.getElementById('qText').textContent      = q.question;
  document.getElementById('qProgress').textContent  = 'Question ' + (current + 1);
  document.getElementById('qFraction').textContent  = (current + 1) + ' / ' + total;
  document.getElementById('progressFill').style.width = ((current + 1) / total * 100) + '%';
  document.getElementById('reviewBadge').classList.toggle('show', locked);

  ['feedback','changeAnswerWrap'].forEach(id => {
    const el = document.getElementById(id); el.className = el.className.split(' ')[0];
  });
  document.getElementById('feedback').textContent = '';

  const opts = getOptions(q), container = document.getElementById('options');
  container.innerHTML = '';
  opts.forEach(o => {
    const btn = document.createElement('button');
    btn.className = 'option';
    btn.innerHTML = '<span class="opt-letter">' + o.letter + '</span><span>' + o.text + '</span>';
    const showLocked = locked || !!prevResult;
    if (showLocked) {
      btn.classList.add('disabled');
      if (o.letter === q.answer_letter) btn.classList.add('correct');
      else if (prevResult && o.letter === prevResult.selectedLetter && !prevResult.correct) btn.classList.add('wrong');
    } else {
      btn.onclick = () => selectOption(o.letter, btn);
    }
    container.appendChild(btn);
  });

  const fb = document.getElementById('feedback');
  const nextBtn = document.getElementById('nextBtn');

  if (locked) {
    // Review mode: always show feedback, never show change-answer
    if (prevResult && !prevResult.skipped) {
      fb.className = 'feedback show ' + (prevResult.correct ? 'correct-fb' : 'wrong-fb');
      fb.textContent = prevResult.correct
        ? '✓ Correct!' + (q.explanation ? ' ' + q.explanation : '')
        : '✗ The correct answer is ' + q.answer_letter + ': ' + q.answer_text + (q.explanation ? ' — ' + q.explanation : '');
    } else {
      fb.className = 'feedback show skipped-fb';
      fb.textContent = '○ Skipped — the correct answer is ' + q.answer_letter + ': ' + q.answer_text + (q.explanation ? ' — ' + q.explanation : '');
    }
  } else if (prevResult) {
    answered = true; nextBtn.classList.remove('skip-mode');
    fb.className = 'feedback show ' + (prevResult.correct ? 'correct-fb' : 'wrong-fb');
    fb.textContent = prevResult.correct
      ? '✓ Correct!' + (q.explanation ? ' ' + q.explanation : '')
      : '✗ The correct answer is ' + q.answer_letter + ': ' + q.answer_text + (q.explanation ? ' — ' + q.explanation : '');
    document.getElementById('changeAnswerWrap').className = 'change-answer-wrap show';
  } else {
    answered = false; nextBtn.classList.add('skip-mode');
  }

  if (!locked) nextBtn.textContent = isLast ? 'Submit & Finish 🎯' : 'Next →';
  document.getElementById('prevBtn').disabled = current === 0;

  renderQNav();
}

// ── Active quiz-taking ─────────────────────────────────────────────────────────
function selectOption(letter, btn) {
  if (answered) return;
  answered = true;
  const q = QUESTIONS[current], isLast = current === QUESTIONS.length - 1, correct = letter === q.answer_letter;
  document.querySelectorAll('.option').forEach(b => {
    b.classList.add('disabled');
    if (b.querySelector('.opt-letter').textContent === q.answer_letter) b.classList.add('correct');
  });
  if (!correct) btn.classList.add('wrong');
  const fb = document.getElementById('feedback');
  fb.className = 'feedback show ' + (correct ? 'correct-fb' : 'wrong-fb');
  fb.textContent = correct
    ? '✓ Correct!' + (q.explanation ? ' ' + q.explanation : '')
    : '✗ The correct answer is ' + q.answer_letter + ': ' + q.answer_text + (q.explanation ? ' — ' + q.explanation : '');
  results = results.filter(r => r.number !== q.number);
  results.push({ number: q.number, correct, selectedLetter: letter });
  document.getElementById('changeAnswerWrap').className = 'change-answer-wrap show';
  const nextBtn = document.getElementById('nextBtn');
  nextBtn.classList.remove('skip-mode');
  nextBtn.textContent = isLast ? 'Submit & Finish 🎯' : 'Next →';
  saveState(); renderQNav();
}

function changeAnswer() {
  if (submitted) return;
  results = results.filter(r => r.number !== QUESTIONS[current].number);
  answered = false; saveState(); render();
}

function animateToQuestion() {
  const card = document.getElementById('questionCard');
  card.style.transition = ''; card.style.opacity = '0'; card.style.transform = 'translateY(12px)';
  setTimeout(() => { render(); card.style.transition = 'opacity .3s, transform .3s'; card.style.opacity = '1'; card.style.transform = 'translateY(0)'; }, 150);
}

function nextQuestion() {
  if (submitted) { /* in review mode this button is hidden, so no-op guard */ return; }
  const isLast = current === QUESTIONS.length - 1;
  if (isLast) {
    const unanswered = QUESTIONS.filter(q => !results.find(r => r.number === q.number)).length;
    if (unanswered > 0) {
      document.getElementById('modalMsg').textContent =
        unanswered + ' question' + (unanswered > 1 ? 's are' : ' is') + ' unanswered and will be marked as wrong. Ready to submit?';
      document.getElementById('submitModal').className = 'modal-overlay show';
    } else { doSubmit(); }
    return;
  }
  current++; saveState(); animateToQuestion();
}

function prevQuestion() {
  if (current === 0) return;
  current--; saveState(); animateToQuestion();
}

function goToQuestion(index) {
  current = index; saveState();
  document.getElementById('qnavPanel').classList.remove('show');
  document.getElementById('qnavToggleBtn').classList.remove('active');
  animateToQuestion();
}

function closeModal()    { document.getElementById('submitModal').className = 'modal-overlay'; }
function confirmSubmit() { closeModal(); doSubmit(); }

// ── Submit (client-side only — no webhook, nothing leaves the browser) ───────
function doSubmit() {
  QUESTIONS.forEach(q => {
    if (!results.find(r => r.number === q.number))
      results.push({ number: q.number, correct: false, selectedLetter: null, skipped: true });
  });
  submitted = true;
  saveState();
  showResultsSummary();
}

function showResultsSummary() {
  reviewing = false;
  document.getElementById('questionCard').style.display    = 'none';
  document.getElementById('navRow').style.display           = 'none';
  document.querySelector('.qnav-wrap').style.display        = 'none';
  document.getElementById('backToResultsWrap').classList.remove('show');
  document.getElementById('reviewBadge').classList.remove('show');
  document.getElementById('resultsCard').className           = 'results-card show';

  const correct = results.filter(r => r.correct).length;
  const skipped = results.filter(r => r.skipped).length;
  const wrong   = results.filter(r => !r.correct && !r.skipped).length;
  const pct     = Math.round(correct / QUESTIONS.length * 100);

  document.getElementById('scoreBig').textContent     = correct + ' / ' + QUESTIONS.length;
  document.getElementById('scorePercent').textContent = pct + '% Correct';
  document.getElementById('statCorrect').textContent  = correct;
  document.getElementById('statWrong').textContent    = wrong;
  document.getElementById('statSkipped').textContent  = skipped;
}

// ── Review mode ───────────────────────────────────────────────────────────────
function enterReview() {
  reviewing = true;
  document.getElementById('resultsCard').className = 'results-card';
  document.getElementById('questionCard').style.display = 'block';
  document.querySelector('.qnav-wrap').style.display    = 'block';
  document.getElementById('backToResultsWrap').classList.add('show');
  // Re-enable Prev/Next for free browsing in review mode
  document.getElementById('navRow').style.display = 'flex';
  document.getElementById('nextBtn').onclick = reviewNext;
  document.getElementById('prevBtn').onclick = reviewPrev;
  document.getElementById('nextBtn').classList.remove('skip-mode');
  document.getElementById('nextBtn').textContent = 'Next →';
  current = 0;
  saveState();
  render();
}

function reviewNext() {
  if (current >= QUESTIONS.length - 1) return;
  current++; saveState(); animateToQuestion();
}
function reviewPrev() {
  if (current <= 0) return;
  current--; saveState(); animateToQuestion();
}

function backToResults() {
  document.getElementById('backToResultsWrap').classList.remove('show');
  showResultsSummary();
}

// ── Question nav grid ─────────────────────────────────────────────────────────
function toggleQNav() {
  const p = document.getElementById('qnavPanel'), b = document.getElementById('qnavToggleBtn');
  p.classList.toggle('show'); b.classList.toggle('active', p.classList.contains('show'));
}
function renderQNav() {
  const grid = document.getElementById('qnavGrid'); if (!grid) return;
  grid.innerHTML = QUESTIONS.map((q, i) => {
    const r = results.find(r => r.number === q.number && !r.skipped);
    let cls = 'qnav-chip';
    if (i === current)          cls += ' qn-current';
    else if (r && r.correct)    cls += ' qn-correct';
    else if (r && !r.correct)   cls += ' qn-wrong';
    return '<button class="' + cls + '" onclick="goToQuestion(' + i + ')" title="Q' + q.number + '">' + q.number + '</button>';
  }).join('');
}

// ── Animated background ───────────────────────────────────────────────────────
(function initBackground() {
  const canvas = document.getElementById('bgCanvas'), ctx = canvas.getContext('2d');
  const mobile = window.innerWidth < 600, N = mobile ? 40 : 75;
  const PALETTE = [[96,165,250],[168,85,247],[45,212,191],[251,146,60],[232,121,249],[52,211,153]];
  let dots = [], w, h, raf;
  function resize() {
    w = canvas.width = window.innerWidth; h = canvas.height = window.innerHeight;
    dots = Array.from({ length: N }, () => {
      const col = PALETTE[Math.floor(Math.random() * PALETTE.length)];
      return { x: Math.random()*w, y: Math.random()*h, r: Math.random()*2+0.5, vx: (Math.random()-.5)*.42, vy: (Math.random()-.5)*.42, op: Math.random()*.5+.18, col };
    });
  }
  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < dots.length; i++) for (let j = i+1; j < dots.length; j++) {
      const dx=dots[i].x-dots[j].x, dy=dots[i].y-dots[j].y, d=Math.sqrt(dx*dx+dy*dy);
      if (d < 120) { const c=dots[i].col; ctx.beginPath(); ctx.strokeStyle='rgba('+c[0]+','+c[1]+','+c[2]+','+(0.1*(1-d/120))+')'; ctx.lineWidth=0.7; ctx.moveTo(dots[i].x,dots[i].y); ctx.lineTo(dots[j].x,dots[j].y); ctx.stroke(); }
    }
    dots.forEach(d => {
      d.x=(d.x+d.vx+w)%w; d.y=(d.y+d.vy+h)%h;
      ctx.beginPath(); ctx.arc(d.x,d.y,d.r,0,Math.PI*2);
      ctx.fillStyle='rgba('+d.col[0]+','+d.col[1]+','+d.col[2]+','+d.op+')'; ctx.fill();
    });
    raf = requestAnimationFrame(draw);
  }
  window.addEventListener('resize', () => { cancelAnimationFrame(raf); resize(); draw(); });
  resize(); draw();
})();

// ── Init ──────────────────────────────────────────────────────────────────────
loadState();
if (submitted) {
  // Returning visitor after already submitting — show results summary directly
  showResultsSummary();
} else {
  render();
}
</script>
</body>
</html>`;
}
