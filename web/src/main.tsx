import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installStaleBuildReload } from './lib/stale-build'
import { loadSite, SITE_LOADED_EVENT } from './lib/site'

installStaleBuildReload()

// the site's name and text are in the dictionaries before anything renders
// (a site that arrives late re-renders the text through the i18n provider)
void loadSite(() => window.dispatchEvent(new Event(SITE_LOADED_EVENT))).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
