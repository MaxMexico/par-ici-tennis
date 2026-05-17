import { Client } from '@gradio/client'
import { config } from '../staticFiles.js'

export const huggingFaceAPI = async (captchaBlob) => {
  const space = config.ai?.space || 'FatBoyEnglish/Text_Captcha_breaker'
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const client = await Client.connect(space)
      const result = await client.predict('/predict', { img_org: captchaBlob })
      console.log(result.data[0])
      return result.data[0].replace(/\||-/gi, '').substr(0, 6)
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
