// Pesquisa no histórico do grupo (export _chat.txt + mensagens recebidas pelo bot)
// para o bot poder citar o que foi mesmo dito, com data.
import fs from 'node:fs'

const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const LINE = /^\u200e?\[(\d\d\/\d\d\/\d{4}), (\d\d:\d\d):\d\d\] ([^:]+): (.*)/
const EMAIL = /\S+@\S+\.\w+/

let exportMsgs = null
function loadExport() {
  if (exportMsgs) return exportMsgs
  exportMsgs = []
  try {
    for (const line of fs.readFileSync('_chat.txt', 'utf8').split('\n')) {
      const m = line.match(LINE)
      if (!m || m[4].includes('\u200e') || EMAIL.test(m[4])) continue // sem media/sistema/emails
      exportMsgs.push({ date: m[1], name: m[3], text: m[4].trim() })
    }
  } catch { /* sem export: usa só o histórico do bot */ }
  return exportMsgs
}

function loadLive(jid) {
  try {
    return fs.readFileSync(`data/${jid.replace(/[^\w.-]/g, '_')}.jsonl`, 'utf8').split('\n').filter(Boolean).map(l => {
      const m = JSON.parse(l)
      return { date: new Date(m.ts).toLocaleDateString('pt-PT'), name: m.name, text: m.text }
    })
  } catch { return [] }
}

// Devolve até `max` excertos (com contexto) das mensagens que mais batem com a pergunta
export function procurar(jid, query, { max = 4, ctx = 4 } = {}) {
  const msgs = [...loadExport(), ...loadLive(jid)]
  const texts = msgs.map(m => { const n = norm(m.text); return n + ' ' + n.replace(/\s+/g, '') }) // "flash score" também bate em "flashscore"
  const N = texts.length
  // palavras raras no grupo valem mais (idf); palavras de 1-2 letras ignoradas
  const terms = [...new Set(norm(query).match(/[a-z0-9]{3,}/g) || [])]
    .map(t => ({ t, df: texts.reduce((n, x) => n + x.includes(t), 0) }))
    .filter(({ df }) => df > 0)
    .map(({ t, df }) => ({ t, w: Math.log(N / df) }))
  if (!terms.length) return ''

  // que termos aparece em cada mensagem (as do bot não contam: não se cita a si próprio)
  const bot = process.env.BOT_NAME
  const lineHits = texts.map((x, i) => msgs[i].name === bot ? [] : terms.filter(({ t }) => x.includes(t)))

  // pontua por bloco de conversa: termos diferentes espalhados por mensagens seguidas contam juntos
  const scored = []
  lineHits.forEach((hits, i) => {
    if (!hits.length) return
    const found = new Map()
    for (let j = Math.max(0, i - ctx); j <= Math.min(texts.length - 1, i + ctx); j++)
      for (const h of lineHits[j]) found.set(h.t, h.w)
    const ws = [...found.values()]
    scored.push({ i, s: ws.reduce((a, b) => a + b, 0) * (1 + 0.5 * (ws.length - 1)) })
  })
  scored.sort((a, b) => b.s - a.s)

  const picked = []
  for (const h of scored) {
    if (picked.length >= max) break
    if (picked.every(p => Math.abs(p.i - h.i) > ctx * 2)) picked.push(h)
  }
  return picked.sort((a, b) => a.i - b.i).map(({ i }) =>
    msgs.slice(Math.max(0, i - ctx), i + ctx + 1)
      .map(m => `[${m.date}] ${m.name}: ${m.text.slice(0, 200)}`).join('\n'),
  ).join('\n---\n')
}
