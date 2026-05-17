import { config } from '../staticFiles.js'

// Inference API HuggingFace — fonctionne sans token (rate-limité) ou avec un token HF gratuit
// Pour améliorer la fiabilité, ajoutez dans config.json: "ai": { "hfToken": "hf_xxx" }
// Modèle par défaut fine-tuné sur CAPTCHAs texte. Override via: "ai": { "model": "autre/modele" }
export const huggingFaceAPI = async (captchaBlob) => {
  const model = config.ai?.model || 'anuashok/ocr-captcha-v3'
  const token = config.ai?.hfToken || process.env.HF_TOKEN

  const headers = { 'Content-Type': 'application/octet-stream' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const arrayBuffer = await captchaBlob.arrayBuffer()

  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
        method: 'POST',
        headers,
        body: Buffer.from(arrayBuffer),
      })

      if (response.status === 503) {
        // Modèle en cours de chargement, attendre et réessayer
        const { estimated_time } = await response.json().catch(() => ({ estimated_time: 20 }))
        const waitMs = Math.min((estimated_time || 20) * 1000, 30000)
        console.log(`HuggingFace: modèle en chargement, attente ${(waitMs / 1000).toFixed(0)}s...`)
        await new Promise(resolve => setTimeout(resolve, waitMs))
        continue
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const result = await response.json()
      const text = (result?.[0]?.generated_text || '').replace(/[^a-zA-Z0-9$@#&]/g, '').substring(0, 8)
      console.log(`HuggingFace OCR: "${text}"`)
      return text
    } catch (err) {
      lastErr = err
      if (attempt < 3) {
        console.log(`HuggingFace tentative ${attempt} échouée, retry dans 5s...`)
        await new Promise(resolve => setTimeout(resolve, 5000))
      }
    }
  }
  throw lastErr
}
