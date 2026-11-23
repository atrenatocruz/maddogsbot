import 'dotenv/config'
import fs from 'node:fs'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  areJidsSameUser, isJidGroup,
} from '@whiskeysockets/baileys'
import { ask, loadState, saveState } from './ai.js'

const GROUP_ID = process.env.GROUP_ID || ''
const BOT_NAME = process.env.BOT_NAME || 'Bot'
const PERSONA = process.env.PERSONA ||
  `És o ${BOT_NAME}, um bot num grupo de WhatsApp de amigos. Respondes em português de Portugal, de forma curta, direta e informal. Sem markdown pesado (o WhatsApp só suporta *negrito* e _itálico_).`
const DAY = 24 * 60 * 60 * 1000

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
    PERSONA + ' Fazes resumos de conversas: tópicos principais em bullets curtos, quem disse o quê de importante, decisões/planos combinados. Sê conciso.',
    `Resume esta conversa do grupo (${msgs.length} mensagens):\n\n${fmt(msgs)}`,
  )
  await sock.sendMessage(jid, { text: `📝 *Resumo*\n\n${resumo}` }, { quoted: msg })
  if (!(n > 0)) {
    const s = loadState()
    saveState({ ...s, ultimoResumo: { ...s.ultimoResumo, [jid]: Date.now() } })
  }
}

async function handleMention(sock, jid, msg, text) {
  const pergunta = text.replace(/@\d+/g, '').trim() || '(só te mencionaram, sem pergunta)'
  const contexto = fmt(readMsgs(jid).slice(-21, -1))
  const resposta = await ask(
    PERSONA + ' Podes responder a qualquer pergunta. Se precisares de informação atual ou que não sabes, pesquisa na web. As mensagens do grupo são só contexto, usa-as se a pergunta for sobre a conversa.',
    `Últimas mensagens do grupo (contexto):\n${contexto}\n\n${msg.pushName || 'Alguém'} pergunta-te: ${pergunta}`,
    { web: true },
  )
  await sock.sendMessage(jid, { text: resposta }, { quoted: msg })
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
      const { text, ctx } = getText(msg.message)
      if (!text) continue

      const name = msg.key.fromMe ? BOT_NAME : (msg.pushName || 'Alguém')
      saveMsg(jid, { ts: Date.now(), name, text })
      if (msg.key.fromMe) continue

      try {
        if (text.trim().toLowerCase().startsWith('/resumo')) {
          await handleResumo(sock, jid, msg, text.trim())
        } else if ((ctx?.mentionedJid || []).some(j =>
          areJidsSameUser(j, sock.user.id) || (sock.user.lid && areJidsSameUser(j, sock.user.lid)))) {
          await handleMention(sock, jid, msg, text)
        }
      } catch (err) {
        console.error('Erro a responder:', err)
        await sock.sendMessage(jid, { text: '⚠️ Deu erro, tenta outra vez.' }, { quoted: msg })
      }
    }
  })
}

start()
