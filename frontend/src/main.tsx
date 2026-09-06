import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import UpdatePrompt from './components/UpdatePrompt/UpdatePrompt.tsx'

// The update prompt is a sibling of the app, not a part of it: it reports on
// the service worker that serves the shell, which has nothing to do with the
// board's state — and App.tsx stays pure composition of that state.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <UpdatePrompt />
  </StrictMode>,
)
