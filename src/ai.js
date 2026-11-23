import Anthropic from '@anthropic-ai/sdk'
import fs from 'node:fs'

const STATE_FILE = 'state.json'
const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5'
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b'

export function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
export function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

const CHAT_TOOL = {
  name: 'procurar_no_chat',
  description: 'Pesquisa no histórico completo do grupo de WhatsApp (desde 2024) e devolve as mensagens encontradas com data, autor e as mensagens à volta. Usa palavras-chave específicas (nomes, clubes, sítios, termos raros), não frases. Podes chamar várias vezes com termos diferentes ou sinónimos para ir mais a fundo.',
  input_schema: {
    type: 'object',
    properties: { termos: { type: 'string', description: 'Palavras-chave separadas por espaços, ex: "brest monaco flashscore"' } },
    required: ['termos'],
  },
}

async function askClaude(system, prompt, web, chatSearch) {
  const messages = [{ role: 'user', content: prompt }]
  const tools = []
  if (web) tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 })
  if (chatSearch) tools.push(CHAT_TOOL)
  let res
  for (let i = 0; i < 8; i++) {
    res = await claude.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system,
      messages,
      tools: tools.length ? tools : undefined,
    })
    if (res.stop_reason === 'pause_turn') { // pesquisa web longa: continuar
      messages.push({ role: 'assistant', content: res.content })
      continue
    }
    if (res.stop_reason !== 'tool_use') break
    messages.push({ role: 'assistant', content: res.content })
    const results = res.content.filter(b => b.type === 'tool_use').map(b => {
      console.log(`[chat] pesquisa: ${b.input?.termos}`)
      return { type: 'tool_result', tool_use_id: b.id, content: chatSearch(String(b.input?.termos || '')) || 'Nada encontrado com esses termos.' }
    })
    messages.push({ role: 'user', content: results })
  }
  if (res.stop_reason === 'refusal') return 'Não posso responder a isso.'
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
}

async function askGroq(system, prompt, web) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 2000,
      tools: web ? [{ type: 'browser_search' }] : undefined,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.choices[0].message.content.replace(/【[^】]*】/g, '').trim() // tira marcas de citação
}

// WhatsApp usa *negrito*, não **negrito**
const toWhatsApp = t => t.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#+\s*/gm, '')

export async function ask(system, prompt, opts) {
  return toWhatsApp(await askAny(system, prompt, opts))
}

// chatSearch: função (termos) => excertos do histórico. searchQuery: texto usado para pesquisar quando o Groq não tem a ferramenta.
async function askAny(system, prompt, { web = false, chatSearch = null, searchQuery = '' } = {}) {
  const state = loadState()
  if (claude && !state.claude_esgotado) {
    try {
      return await askClaude(system, prompt, web, chatSearch)
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) {
        console.log('[ai] Créditos Claude esgotados → a passar para Groq')
        saveState({ ...loadState(), claude_esgotado: true })
      } else {
        console.error('[ai] Erro Claude, a tentar Groq:', err.message)
      }
    }
  }
  // Groq: sem ferramenta de chat, junta logo os excertos encontrados por palavras-chave
  const excertos = chatSearch && searchQuery ? chatSearch(searchQuery) : ''
  return askGroq(system, (excertos ? `Excertos do histórico do grupo que podem ser relevantes:\n${excertos}\n\n` : '') + prompt, web)
}
