import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installStaleBuildReload } from './lib/stale-build'
import { loadSite, SITE_LOADED_EVENT } from './lib/site'
import { initialLang, LANG_META, loadLang } from './i18n'

installStaleBuildReload()

// the site's name and text and the reader's language are in the dictionaries
// before anything renders (a site that arrives late re-renders the text
// through the i18n provider; a language that fails to load falls back to English)
const lang = initialLang()
document.documentElement.lang = LANG_META[lang].tag
document.documentElement.dir = LANG_META[lang].rtl ? 'rtl' : 'ltr'
void Promise.all([
  loadSite(() => window.dispatchEvent(new Event(SITE_LOADED_EVENT))),
  loadLang(lang).catch(() => {}),
]).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
