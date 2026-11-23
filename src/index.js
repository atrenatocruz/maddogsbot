import 'dotenv/config'
import fs from 'node:fs'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  areJidsSameUser, isJidGroup,
} from '@whiskeysockets/baileys'
import { ask, loadState, saveState } from './ai.js'
import { procurar } from './historico.js'

const GROUP_ID = process.env.GROUP_ID || ''
const BOT_NAME = process.env.BOT_NAME || 'Bot'
const DEFAULT_PERSONA =
  `És o ${BOT_NAME}, um bot num grupo de WhatsApp de amigos. Respondes em português de Portugal, de forma curta, direta e informal. Sem markdown pesado (o WhatsApp só suporta *negrito* e _itálico_).`
const DAY = 24 * 60 * 60 * 1000

// perfis.json é lido a cada mensagem, para poderes editá-lo sem reiniciar
function loadPerfis() {
  try { return JSON.parse(fs.readFileSync('perfis.json', 'utf8')) } catch { return { membros: [] } }
}
function persona(perfis) {
  if (!perfis.persona) return DEFAULT_PERSONA
  const membros = perfis.membros.map(m => `- ${m.nome} (${m.alcunhas.join(', ')}): ${m.perfil}`).join('\n')
  return `${perfis.persona}\n\nMembros do grupo:\n${membros}`
}

const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const numberOf = jid => (jid || '').split('@')[0].split(':')[0]

// Descobre quem é: 1) número já conhecido, 2) nome do WhatsApp (e memoriza o número)
function findMember(perfis, msg) {
  const num = numberOf(msg.key.participantAlt || msg.key.participant)
  let m = perfis.membros.find(p => p.numeros?.map(String).includes(num))
  const contactos = readJson('data/contactos.json')
  if (!m && contactos[num]) m = perfis.membros.find(p => p.nome === contactos[num])
  if (m) return m

  const tokens = norm(msg.pushName).split(/\s+/).filter(Boolean)
  const scored = perfis.membros.map(p => {
    const known = new Set([...norm(p.nome).split(/\s+/), ...p.alcunhas.map(norm)])
    return { p, score: tokens.filter(t => known.has(t)).length }
  }).sort((a, b) => b.score - a.score)
  if (scored[0]?.score > 0 && scored[0].score !== scored[1]?.score) {
    m = scored[0].p
    // guarda o número e o LID, para depois reconhecer @menções a esta pessoa
    const keys = [num, numberOf(msg.key.participant)]
    fs.writeFileSync('data/contactos.json', JSON.stringify({ ...contactos, ...Object.fromEntries(keys.map(k => [k, m.nome])) }, null, 2))
    console.log(`[perfis] ${msg.pushName} (${num}) → ${m.nome}`)
  } else {
    console.log(`[perfis] não reconheci ${msg.pushName} (${num}) — põe o número em "numeros" no perfis.json`)
  }
  return m
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return {} } }

const isBot = (sock, j) => !!j && (areJidsSameUser(j, sock.user.id) || (sock.user.lid && areJidsSameUser(j, sock.user.lid)))

// Troca "@351912345678" / "@2663391431" pelo nome da pessoa (ou do bot)
async function resolveMentions(sock, text, ctx) {
  const perfis = loadPerfis()
  const contactos = readJson('data/contactos.json')
  for (const j of ctx?.mentionedJid || []) {
    const num = numberOf(j)
    let nome = isBot(sock, j) ? BOT_NAME : null
    if (!nome) {
      const nums = [num]
      if (j.endsWith('@lid')) {
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID(j).catch(() => null)
        if (pn) nums.push(numberOf(pn))
      }
      nome = nums.map(n => perfis.membros.find(p => p.numeros?.map(String).includes(n))?.nome || contactos[n]).find(Boolean)
    }
    text = text.replaceAll(`@${num}`, `@${nome || 'alguém'}`)
  }
  return text
}

fs.mkdirSync('data', { recursive: true })
const logFile = jid => `data/${jid.replace(/[^\w.-]/g, '_')}.jsonl`

function saveMsg(jid, entry) {
  fs.appendFileSync(logFile(jid), JSON.stringify(entry) + '\n')
}
function readMsgs(jid) {
  try {
    return fs.readFileSync(logFile(jid), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch { return [] }
}
const fmt = msgs => msgs.map(m => `${m.name}: ${m.text}`).join('\n')

function getText(message) {
  const m = message?.ephemeralMessage?.message || message?.viewOnceMessageV2?.message || message
  if (!m) return { text: '', ctx: null }
  const ctx = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo || null
  const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || ''
  return { text, ctx }
}

async function handleResumo(sock, jid, msg, text) {
  const n = parseInt(text.split(/\s+/)[1], 10)
  const all = readMsgs(jid).filter(m => !m.text.startsWith('/resumo'))
  const state = loadState()
  let msgs
  if (n > 0) {
    msgs = all.slice(-Math.min(n, 1000))
  } else {
    const since = Math.max(state.ultimoResumo?.[jid] || 0, Date.now() - DAY)
    msgs = all.filter(m => m.ts > since).slice(-1000)
  }
  if (msgs.length === 0) {
    return sock.sendMessage(jid, { text: 'Não há mensagens novas para resumir.' }, { quoted: msg })
  }
  const resumo = await ask(
    persona(loadPerfis()) + '\n\nFazes resumos de conversas: tópicos principais em bullets curtos, quem disse o quê de importante, decisões/planos combinados. Sê conciso.',
    `Resume esta conversa do grupo (${msgs.length} mensagens):\n\n${fmt(msgs)}`,
  )
  await reply(sock, jid, msg, `📝 *Resumo*\n\n${resumo}`)
  if (!(n > 0)) {
    const s = loadState()
    saveState({ ...s, ultimoResumo: { ...s.ultimoResumo, [jid]: Date.now() } })
  }
}

async function handleMention(sock, jid, msg, text, ctx) {
  let pergunta = text.replaceAll(`@${BOT_NAME}`, '').trim() || '(só te mencionaram, sem pergunta)'
  const citado = getText(ctx?.quotedMessage).text
  if (citado && isBot(sock, ctx.participant)) pergunta = `(a responder à tua mensagem "${citado}") ${pergunta}`
  else if (citado) pergunta = `(a citar a mensagem "${citado}") ${pergunta}`
  const contexto = fmt(readMsgs(jid).slice(-21, -1))
  const perfis = loadPerfis()
  const quem = findMember(perfis, msg)
  const autor = quem ? `${quem.nome} (${quem.alcunhas[0]})` : (msg.pushName || 'Alguém')
  const resposta = await ask(
    persona(perfis) + '\n\nPodes responder a qualquer pergunta. Se precisares de informação atual ou que não sabes, pesquisa na web. As mensagens do grupo são só contexto, usa-as se a pergunta for sobre a conversa.' +
      '\n\nHISTÓRICO DO GRUPO: tens a ferramenta procurar_no_chat com todo o histórico desde 2024. Sempre que te pedirem para explicar, confirmar ou provar algo que foi dito no grupo, ou quando falares de algo que aconteceu no grupo, VAI A FUNDO: pesquisa antes de responder, várias vezes se for preciso, com palavras-chave específicas e sinónimos (nomes, clubes, sítios, termos raros), até encontrares a conversa original. Depois diz quando foi (data) e quem disse o quê, citando as mensagens curtas entre aspas; nesse caso podes usar até 4 linhas. Se não encontrares, admite em vez de inventar.' +
      (quem ? `\n\nQuem te está a falar agora é o ${quem.nome}. Adapta a resposta e a boca a ele, com base no perfil dele.` : ''),
    `Últimas mensagens do grupo (contexto):\n${contexto}\n\n${autor} pergunta-te: ${pergunta}\n\n(Responde como no group chat: MÁXIMO 20 palavras, 1 frase. Só o essencial + a boca. Exceção: se for para explicar/confirmar algo do histórico, cita as mensagens com data, até 4 linhas.)`,
    { web: true, chatSearch: termos => procurar(jid, termos), searchQuery: pergunta },
  )
  await reply(sock, jid, msg, resposta)
}

// Mostra "a escrever…" e espera 1–3 s antes de enviar, como uma pessoa
async function reply(sock, jid, msg, text) {
  await sock.sendPresenceUpdate('composing', jid).catch(() => {})
  await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000))
  await sock.sendPresenceUpdate('paused', jid).catch(() => {})
  await sock.sendMessage(jid, { text }, { quoted: msg })
  saveMsg(jid, { ts: Date.now(), name: BOT_NAME, text })
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'warn' }) })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('Lê este QR com o WhatsApp do bot (Dispositivos ligados → Ligar dispositivo):')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'open') {
      console.log('✅ Ligado como', sock.user.id)
      const groups = await sock.groupFetchAllParticipating()
      for (const g of Object.values(groups)) console.log(`   grupo: ${g.subject}  →  ${g.id}`)
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('❌ Sessão terminada. Apaga a pasta auth/ e volta a correr para novo QR.')
      } else {
        console.log('Ligação caiu, a reconectar...', code)
        setTimeout(start, 3000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      const jid = msg.key.remoteJid
      if (!isJidGroup(jid) || (GROUP_ID && jid !== GROUP_ID)) continue
      const { text: raw, ctx } = getText(msg.message)
      if (!raw || msg.key.fromMe) continue
      const text = await resolveMentions(sock, raw, ctx)
      saveMsg(jid, { ts: Date.now(), name: msg.pushName || 'Alguém', text })

      try {
        const isResumo = text.trim().toLowerCase().startsWith('/resumo')
        const isParaBot = (ctx?.mentionedJid || []).some(j => isBot(sock, j)) || isBot(sock, ctx?.participant)
        if (isResumo || isParaBot) sock.sendPresenceUpdate('composing', jid).catch(() => {}) // "a escrever…" enquanto pensa
        if (isResumo) {
          await handleResumo(sock, jid, msg, text.trim())
        } else if (isParaBot) {
          // @menção ao bot, ou resposta a uma mensagem do bot
          await handleMention(sock, jid, msg, text, ctx)
        }
      } catch (err) {
        console.error('Erro a responder:', err)
        await sock.sendMessage(jid, { text: '⚠️ Deu erro, tenta outra vez.' }, { quoted: msg })
      }
    }
  })
}

export { findMember, persona, loadPerfis, resolveMentions, isBot, handleMention }
if (process.argv[1]?.endsWith("index.js")) start()
