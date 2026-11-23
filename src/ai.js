import Anthropic from '@anthropic-ai/sdk'
import fs from 'node:fs'

const STATE_FILE = 'state.json'
const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5'
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
const GROQ_WEB_MODEL = process.env.GROQ_WEB_MODEL || 'groq/compound-mini' // tem pesquisa web incluída

export function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
export function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

async function askClaude(system, prompt, web) {
  const messages = [{ role: 'user', content: prompt }]
  const tools = web ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] : undefined
  let res
  for (let i = 0; i < 3; i++) {
    res = await claude.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system,
      messages,
      tools,
    })
    if (res.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: res.content }) // pesquisa longa: continuar
  }
  if (res.stop_reason === 'refusal') return 'Não posso responder a isso.'
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
}

async function askGroq(system, prompt, web) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: web ? GROQ_WEB_MODEL : GROQ_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.choices[0].message.content.trim()
}

export async function ask(system, prompt, { web = false } = {}) {
  const state = loadState()
  if (claude && !state.claude_esgotado) {
    try {
      return await askClaude(system, prompt, web)
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) {
        console.log('[ai] Créditos Claude esgotados → a passar para Groq')
        saveState({ ...loadState(), claude_esgotado: true })
      } else {
        console.error('[ai] Erro Claude, a tentar Groq:', err.message)
      }
    }
  }
  return askGroq(system, prompt, web)
}
