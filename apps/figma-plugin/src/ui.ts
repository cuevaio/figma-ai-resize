import type {
  InitSelectionStatePayload,
  InvalidSelectionReason,
  MainToUiMessage,
  PresetId,
  SelectionInfo
} from './messages'

type SessionPhase = 'generating' | 'ready' | 'refining'

type SessionState = {
  runId: string
  phase: SessionPhase
  lockedSelection: SelectionInfo | null
  refineCount: number
  createdFrameId: string | null
}

/* ------------------------------------------------------------------ */
/*  Injected stylesheet (keyframes, pseudo-class rules, global resets) */
/* ------------------------------------------------------------------ */

function injectStyles(): void {
  if (document.getElementById('fp-styles')) return
  const style = document.createElement('style')
  style.id = 'fp-styles'
  style.textContent = `
    :root {
      --figma-color-bg: #ffffff;
      --figma-color-bg-secondary: #f5f5f5;
      --figma-color-bg-tertiary: #e5e5e5;
      --figma-color-border: #e5e5e5;
      --figma-color-text: #333333;
      --figma-color-text-secondary: #666666;
      --figma-color-text-tertiary: #999999;
    }

    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; overflow: hidden; }

    @keyframes fp-fade-in {
      from { opacity: 0; transform: translateY(2px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @keyframes fp-pulse {
      0%, 100% { opacity: 0.3; }
      50%      { opacity: 1; }
    }

    @keyframes fp-progress-sweep {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(200%); }
    }

    .fp-btn-primary {
      transition: background 150ms ease, box-shadow 150ms ease,
                  opacity 150ms ease, transform 80ms ease;
    }
    .fp-btn-primary:hover:not(:disabled) {
      background: #14b8a6 !important;
      box-shadow: 0 2px 6px rgba(0,0,0,0.12) !important;
    }
    .fp-btn-primary:active:not(:disabled) {
      background: #0f766e !important;
      transform: scale(0.98);
    }
    .fp-btn-primary:disabled {
      cursor: default !important;
    }
    .fp-btn-primary:focus-visible {
      outline: 2px solid #0d9488;
      outline-offset: 1px;
    }

    .fp-btn-secondary {
      transition: background 150ms ease, box-shadow 150ms ease,
                  opacity 150ms ease, transform 80ms ease;
    }
    .fp-btn-secondary:hover:not(:disabled) {
      background: #d4d4d4 !important;
    }
    .fp-btn-secondary:active:not(:disabled) {
      background: #c0c0c0 !important;
      transform: scale(0.98);
    }
    .fp-btn-secondary:disabled {
      cursor: default !important;
    }
    .fp-btn-secondary:focus-visible {
      outline: 2px solid #0d9488;
      outline-offset: 1px;
    }

    .fp-select {
      transition: border-color 150ms ease, box-shadow 150ms ease;
    }
    .fp-select:hover:not(:disabled) {
      border-color: #b0b0b0 !important;
    }
    .fp-select:focus {
      border-color: #0d9488 !important;
      box-shadow: 0 0 0 1px #0d9488;
      outline: none;
    }
    .fp-select:disabled {
      cursor: default;
      opacity: 0.5 !important;
    }

    .fp-status-enter {
      animation: fp-fade-in 200ms ease-out;
    }
  `
  document.head.appendChild(style)
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function setStatusAnimated(
  element: HTMLElement,
  text: string,
  color: string,
  dotsContainer?: HTMLSpanElement
): void {
  element.style.opacity = '0'
  if (dotsContainer) dotsContainer.style.opacity = '0'
  setTimeout(() => {
    element.textContent = text
    element.style.color = color
    element.style.opacity = '1'
    if (dotsContainer) {
      element.appendChild(dotsContainer)
      dotsContainer.style.opacity = '1'
    }
    element.classList.remove('fp-status-enter')
    void element.offsetWidth
    element.classList.add('fp-status-enter')
  }, 100)
}

function showProgress(track: HTMLElement, fill: HTMLElement): void {
  track.style.height = '4px'
  track.style.marginBottom = '8px'
  fill.style.animation = 'fp-progress-sweep 1.5s ease-in-out infinite'
}

function hideProgress(track: HTMLElement, fill: HTMLElement): void {
  track.style.height = '0px'
  track.style.marginBottom = '0px'
  fill.style.animation = 'none'
}

function createPulseDots(): HTMLSpanElement {
  const container = document.createElement('span')
  container.style.display = 'inline-flex'
  container.style.marginLeft = '6px'
  container.style.verticalAlign = 'middle'
  container.style.gap = '3px'
  container.style.transition = 'opacity 150ms ease'
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span')
    dot.style.display = 'inline-block'
    dot.style.width = '4px'
    dot.style.height = '4px'
    dot.style.borderRadius = '50%'
    dot.style.background = '#0d9488'
    dot.style.animation = `fp-pulse 1.2s ease-in-out infinite`
    dot.style.animationDelay = `${i * 0.2}s`
    container.appendChild(dot)
  }
  return container
}

function updateAiCardState(
  card: HTMLElement,
  state: 'idle' | 'running' | 'success' | 'error' | 'warning'
): void {
  const tints: Record<string, string> = {
    idle: 'var(--figma-color-bg, #ffffff)',
    running: '#f0fdfa',
    success: '#ecfdf5',
    error: '#fef2f2',
    warning: '#fffbeb'
  }
  card.style.background = tints[state]
}

function createCardLabel(text: string): HTMLParagraphElement {
  const label = document.createElement('p')
  label.textContent = text
  label.style.margin = '0'
  label.style.fontSize = '10px'
  label.style.fontWeight = '600'
  label.style.letterSpacing = '0.05em'
  label.style.textTransform = 'uppercase'
  label.style.color = 'var(--figma-color-text-tertiary, #999999)'
  label.style.userSelect = 'none'
  return label
}

function createCard(): HTMLDivElement {
  const card = document.createElement('div')
  card.style.background = 'var(--figma-color-bg, #ffffff)'
  card.style.border = '1px solid var(--figma-color-border, #e5e5e5)'
  card.style.borderRadius = '8px'
  card.style.padding = '12px'
  card.style.display = 'flex'
  card.style.flexDirection = 'column'
  card.style.gap = '8px'
  return card
}

/* ------------------------------------------------------------------ */
/*  Main UI                                                            */
/* ------------------------------------------------------------------ */

export default function (
  rootNode: HTMLElement | null,
  data: InitSelectionStatePayload
): void {
  if (rootNode === null) {
    return
  }

  injectStyles()
  rootNode.innerHTML = ''

  /* ---- Container ---- */
  const container = document.createElement('div')
  container.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif'
  container.style.display = 'flex'
  container.style.flexDirection = 'column'
  container.style.height = '100%'
  container.style.background = 'var(--figma-color-bg, #ffffff)'
  container.style.color = 'var(--figma-color-text, #333333)'

  /* ---- Header ---- */
  const header = document.createElement('div')
  header.style.padding = '16px 16px 12px'
  header.style.display = 'flex'
  header.style.flexDirection = 'column'
  header.style.gap = '4px'
  header.style.userSelect = 'none'

  const headerRow = document.createElement('div')
  headerRow.style.display = 'flex'
  headerRow.style.alignItems = 'center'
  headerRow.style.gap = '10px'

  const iconContainer = document.createElement('div')
  iconContainer.style.width = '28px'
  iconContainer.style.height = '28px'
  iconContainer.style.borderRadius = '7px'
  iconContainer.style.background = '#0d9488'
  iconContainer.style.display = 'flex'
  iconContainer.style.alignItems = 'center'
  iconContainer.style.justifyContent = 'center'
  iconContainer.style.flexShrink = '0'
  iconContainer.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M3 11L11 3M11 3H5M11 3V9" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`

  const title = document.createElement('h2')
  title.textContent = 'Resize frame'
  title.style.margin = '0'
  title.style.fontSize = '14px'
  title.style.fontWeight = '700'
  title.style.color = 'var(--figma-color-text, #333333)'

  headerRow.appendChild(iconContainer)
  headerRow.appendChild(title)

  const subtitle = document.createElement('p')
  subtitle.textContent = 'AI-powered responsive layout'
  subtitle.style.margin = '0'
  subtitle.style.fontSize = '11px'
  subtitle.style.color = 'var(--figma-color-text-secondary, #666666)'
  subtitle.style.paddingLeft = '38px'

  header.appendChild(headerRow)
  header.appendChild(subtitle)

  /* ---- Header divider ---- */
  const headerDivider = document.createElement('div')
  headerDivider.style.height = '1px'
  headerDivider.style.background = 'var(--figma-color-border, #e5e5e5)'
  headerDivider.style.flexShrink = '0'

  /* ---- Body (scrollable) ---- */
  const body = document.createElement('div')
  body.style.flex = '1'
  body.style.overflowY = 'auto'
  body.style.padding = '12px 16px'
  body.style.display = 'flex'
  body.style.flexDirection = 'column'
  body.style.gap = '12px'
  body.style.background = 'var(--figma-color-bg-secondary, #f5f5f5)'

  /* ---- Selection card ---- */
  const selectionCard = createCard()
  const selectionLabel = createCardLabel('Selection')

  const status = document.createElement('p')
  status.style.margin = '0'
  status.style.fontSize = '12px'
  status.style.lineHeight = '1.5'
  status.style.fontWeight = '500'
  status.style.transition = 'color 200ms ease, opacity 200ms ease'

  selectionCard.appendChild(selectionLabel)
  selectionCard.appendChild(status)

  /* ---- Settings card ---- */
  const settingsCard = createCard()
  const settingsLabel = createCardLabel('Settings')

  const ratioLabel = document.createElement('label')
  ratioLabel.textContent = 'Aspect ratio'
  ratioLabel.style.fontSize = '12px'
  ratioLabel.style.fontWeight = '500'
  ratioLabel.style.display = 'block'
  ratioLabel.style.color = 'var(--figma-color-text, #333333)'

  const ratioSelect = document.createElement('select')
  ratioSelect.className = 'fp-select'
  ratioSelect.style.width = '100%'
  ratioSelect.style.height = '32px'
  ratioSelect.style.border = '1px solid var(--figma-color-border, #e5e5e5)'
  ratioSelect.style.borderRadius = '6px'
  ratioSelect.style.padding = '0 28px 0 8px'
  ratioSelect.style.fontSize = '12px'
  ratioSelect.style.fontFamily = 'inherit'
  ratioSelect.style.background = 'var(--figma-color-bg, #ffffff)'
  ratioSelect.style.color = 'var(--figma-color-text, #333333)'
  ratioSelect.style.appearance = 'none'
  ratioSelect.style.backgroundImage = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23666' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`
  ratioSelect.style.backgroundPosition = 'right 8px center'
  ratioSelect.style.backgroundRepeat = 'no-repeat'

  for (const preset of data.presets) {
    const option = document.createElement('option')
    option.value = preset.id
    option.textContent = preset.id
    option.selected = preset.id === data.defaultPresetId
    ratioSelect.appendChild(option)
  }

  settingsCard.appendChild(settingsLabel)
  settingsCard.appendChild(ratioLabel)
  settingsCard.appendChild(ratioSelect)

  /* ---- AI Resize card ---- */
  const aiCard = createCard()
  aiCard.style.transition = 'background-color 300ms ease'
  const aiLabel = createCardLabel('AI Resize')

  const progressTrack = document.createElement('div')
  progressTrack.style.height = '0px'
  progressTrack.style.borderRadius = '2px'
  progressTrack.style.background = 'var(--figma-color-bg-tertiary, #e5e5e5)'
  progressTrack.style.overflow = 'hidden'
  progressTrack.style.transition = 'height 250ms ease, margin-bottom 250ms ease'
  progressTrack.style.marginBottom = '0px'

  const progressFill = document.createElement('div')
  progressFill.style.width = '50%'
  progressFill.style.height = '100%'
  progressFill.style.background = '#0d9488'
  progressFill.style.borderRadius = '2px'
  progressTrack.appendChild(progressFill)

  const pulseDots = createPulseDots()

  const adaptationStatus = document.createElement('p')
  adaptationStatus.style.margin = '0'
  adaptationStatus.style.fontSize = '12px'
  adaptationStatus.style.lineHeight = '1.5'
  adaptationStatus.style.color = 'var(--figma-color-text, #333333)'
  adaptationStatus.style.minHeight = '18px'
  adaptationStatus.style.transition = 'color 200ms ease, opacity 200ms ease'
  adaptationStatus.textContent = 'Ready to resize with AI.'

  const backendNote = document.createElement('p')
  backendNote.textContent = 'Uses local backend at localhost:3000'
  backendNote.style.margin = '0'
  backendNote.style.fontSize = '10px'
  backendNote.style.color = 'var(--figma-color-text-tertiary, #999999)'

  aiCard.appendChild(aiLabel)
  aiCard.appendChild(progressTrack)
  aiCard.appendChild(adaptationStatus)
  aiCard.appendChild(backendNote)

  /* ---- Footer ---- */
  const footer = document.createElement('div')
  footer.style.padding = '12px 16px 16px'
  footer.style.borderTop = '1px solid var(--figma-color-border, #e5e5e5)'
  footer.style.flexShrink = '0'
  footer.style.background = 'var(--figma-color-bg, #ffffff)'

  const adaptButton = document.createElement('button')
  adaptButton.type = 'button'
  adaptButton.textContent = 'Resize with AI'
  adaptButton.className = 'fp-btn-primary'
  adaptButton.style.width = '100%'
  adaptButton.style.height = '36px'
  adaptButton.style.borderRadius = '8px'
  adaptButton.style.border = 'none'
  adaptButton.style.background = '#0d9488'
  adaptButton.style.color = '#ffffff'
  adaptButton.style.fontSize = '12px'
  adaptButton.style.fontWeight = '600'
  adaptButton.style.fontFamily = 'inherit'
  adaptButton.style.cursor = 'pointer'
  adaptButton.style.letterSpacing = '0.01em'
  adaptButton.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)'
  adaptButton.style.userSelect = 'none'

  const footerRow = document.createElement('div')
  footerRow.style.display = 'none'
  footerRow.style.gap = '8px'

  const refineButton = document.createElement('button')
  refineButton.type = 'button'
  refineButton.textContent = 'Refine'
  refineButton.className = 'fp-btn-primary'
  refineButton.style.flex = '1'
  refineButton.style.height = '36px'
  refineButton.style.borderRadius = '8px'
  refineButton.style.border = 'none'
  refineButton.style.background = '#0d9488'
  refineButton.style.color = '#ffffff'
  refineButton.style.fontSize = '12px'
  refineButton.style.fontWeight = '600'
  refineButton.style.fontFamily = 'inherit'
  refineButton.style.cursor = 'pointer'
  refineButton.style.letterSpacing = '0.01em'
  refineButton.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)'
  refineButton.style.userSelect = 'none'

  const resetButton = document.createElement('button')
  resetButton.type = 'button'
  resetButton.textContent = 'New Resize'
  resetButton.className = 'fp-btn-secondary'
  resetButton.style.flex = '1'
  resetButton.style.height = '36px'
  resetButton.style.borderRadius = '8px'
  resetButton.style.border = 'none'
  resetButton.style.background = 'var(--figma-color-bg-tertiary, #e5e5e5)'
  resetButton.style.color = 'var(--figma-color-text, #333333)'
  resetButton.style.fontSize = '12px'
  resetButton.style.fontWeight = '600'
  resetButton.style.fontFamily = 'inherit'
  resetButton.style.cursor = 'pointer'
  resetButton.style.letterSpacing = '0.01em'
  resetButton.style.userSelect = 'none'

  footerRow.appendChild(refineButton)
  footerRow.appendChild(resetButton)

  footer.appendChild(adaptButton)
  footer.appendChild(footerRow)

  /* ---- State management ---- */
  let selectionState = data
  let session: SessionState | null = null

  updateSelectionState(selectionState, status)
  syncControls()

  function syncControls(): void {
    updateAiControls(
      selectionState, session,
      ratioSelect, adaptButton, refineButton, resetButton, footerRow
    )
  }

  adaptButton.addEventListener('click', () => {
    if (!selectionState.valid || session !== null) {
      return
    }

    const runId = createRunId()
    session = {
      runId,
      phase: 'generating',
      lockedSelection: null,
      refineCount: 0,
      createdFrameId: null
    }
    syncControls()
    showProgress(progressTrack, progressFill)
    updateAiCardState(aiCard, 'running')
    setStatusAnimated(
      adaptationStatus,
      'Starting adaptation...',
      'var(--figma-color-text, #333333)',
      pulseDots
    )

    parent.postMessage(
      {
        pluginMessage: {
          type: 'START_ADAPTATION',
          payload: {
            runId,
            presetId: ratioSelect.value as PresetId,
            includeScreenshot: true
          }
        }
      },
      '*'
    )
  })

  refineButton.addEventListener('click', () => {
    if (session === null || session.phase !== 'ready') return

    session.phase = 'refining'
    syncControls()
    showProgress(progressTrack, progressFill)
    updateAiCardState(aiCard, 'running')
    setStatusAnimated(
      adaptationStatus,
      'Starting refinement...',
      'var(--figma-color-text, #333333)',
      pulseDots
    )

    parent.postMessage(
      {
        pluginMessage: {
          type: 'REQUEST_REFINE',
          payload: { runId: session.runId }
        }
      },
      '*'
    )
  })

  resetButton.addEventListener('click', () => {
    if (session === null) return
    if (session.phase === 'generating' || session.phase === 'refining') return

    const runId = session.runId
    session = null

    hideProgress(progressTrack, progressFill)
    updateAiCardState(aiCard, 'idle')
    pulseDots.style.display = 'inline-flex'
    setStatusAnimated(
      adaptationStatus,
      'Ready to resize with AI.',
      'var(--figma-color-text, #333333)'
    )
    selectionLabel.textContent = 'Selection'
    updateSelectionState(selectionState, status)
    syncControls()

    parent.postMessage(
      {
        pluginMessage: {
          type: 'RESET_SESSION',
          payload: { runId }
        }
      },
      '*'
    )
  })

  window.onmessage = (event: MessageEvent<{ pluginMessage?: MainToUiMessage }>) => {
    const pluginMessage = event.data.pluginMessage
    if (typeof pluginMessage === 'undefined') {
      return
    }

    if (pluginMessage.type === 'SELECTION_STATE') {
      if (session !== null) return
      selectionState = pluginMessage.payload
      updateSelectionState(selectionState, status)
      syncControls()
      return
    }

    if (pluginMessage.type === 'ADAPTATION_REHYDRATE') {
      const rehydrateSession = pluginMessage.payload.session
      if (rehydrateSession !== null && pluginMessage.payload.activeRun === null) {
        session = {
          runId: rehydrateSession.runId,
          phase: 'ready',
          lockedSelection: rehydrateSession.lockedSelection,
          refineCount: rehydrateSession.refineCount,
          createdFrameId: rehydrateSession.createdFrameId
        }
        selectionLabel.textContent = 'Source (locked)'
        updateSelectionCardForSession(rehydrateSession.lockedSelection, status)
        updateAiCardState(aiCard, 'success')
        setStatusAnimated(
          adaptationStatus,
          'Session active. Refine or start new resize.',
          '#059669'
        )
      } else if (pluginMessage.payload.activeRun !== null) {
        const phase: SessionPhase = rehydrateSession !== null ? 'refining' : 'generating'
        session = {
          runId: pluginMessage.payload.activeRun.runId,
          phase,
          lockedSelection: rehydrateSession?.lockedSelection ?? null,
          refineCount: rehydrateSession?.refineCount ?? 0,
          createdFrameId: rehydrateSession?.createdFrameId ?? null
        }
        if (rehydrateSession !== null) {
          selectionLabel.textContent = 'Source (locked)'
          updateSelectionCardForSession(rehydrateSession.lockedSelection, status)
        }
        const isError = pluginMessage.payload.activeRun.stage === 'FAILED'
        setStatusAnimated(
          adaptationStatus,
          pluginMessage.payload.activeRun.message,
          isError ? '#dc2626' : 'var(--figma-color-text, #333333)',
          isError ? undefined : pulseDots
        )
        if (!isError) {
          showProgress(progressTrack, progressFill)
          updateAiCardState(aiCard, 'running')
        } else {
          updateAiCardState(aiCard, 'error')
        }
      }

      syncControls()
      return
    }

    if (pluginMessage.type === 'SESSION_READY') {
      if (session === null || pluginMessage.payload.runId !== session.runId) return

      session.phase = 'ready'
      session.lockedSelection = pluginMessage.payload.lockedSelection
      session.createdFrameId = pluginMessage.payload.createdFrameId
      session.refineCount = 0

      hideProgress(progressTrack, progressFill)
      pulseDots.style.display = 'none'
      updateAiCardState(
        aiCard,
        pluginMessage.payload.warnings.length > 0 ? 'warning' : 'success'
      )

      const hasWarnings = pluginMessage.payload.warnings.length > 0
      const statusText = hasWarnings
        ? `Layout applied with ${pluginMessage.payload.warnings.length} warning(s). Refine or start new.`
        : 'Layout applied. Refine to improve or start new resize.'
      const statusColor = hasWarnings ? '#d97706' : '#059669'
      setStatusAnimated(adaptationStatus, statusText, statusColor)

      selectionLabel.textContent = 'Source (locked)'
      updateSelectionCardForSession(pluginMessage.payload.lockedSelection, status)

      syncControls()
      return
    }

    if (pluginMessage.type === 'ADAPTATION_STATE') {
      if (session === null) return
      if (pluginMessage.payload.runId !== session.runId) return

      const isFailed = pluginMessage.payload.stage === 'FAILED'
      const isCompleted = pluginMessage.payload.stage === 'COMPLETED'

      if (isFailed) {
        hideProgress(progressTrack, progressFill)
        updateAiCardState(aiCard, 'error')
        pulseDots.style.display = 'none'
        setStatusAnimated(adaptationStatus, pluginMessage.payload.message, '#dc2626')

        if (session.phase === 'refining') {
          session.phase = 'ready'
        } else {
          session = null
          selectionLabel.textContent = 'Selection'
          updateSelectionState(selectionState, status)
        }
        syncControls()
        return
      }

      if (isCompleted) {
        setStatusAnimated(adaptationStatus, pluginMessage.payload.message, '#059669')
        return
      }

      showProgress(progressTrack, progressFill)
      updateAiCardState(aiCard, 'running')
      pulseDots.style.display = 'inline-flex'
      setStatusAnimated(
        adaptationStatus,
        pluginMessage.payload.message,
        'var(--figma-color-text, #333333)',
        pulseDots
      )
      return
    }

    if (pluginMessage.type === 'APPLY_RESULT') {
      if (session === null || pluginMessage.payload.runId !== session.runId) return

      session.phase = 'ready'
      session.refineCount = pluginMessage.payload.pass - 1

      hideProgress(progressTrack, progressFill)
      pulseDots.style.display = 'none'

      const hasWarnings = pluginMessage.payload.warnings.length > 0
      updateAiCardState(aiCard, hasWarnings ? 'warning' : 'success')

      const statusText = hasWarnings
        ? `Refinement applied with ${pluginMessage.payload.warnings.length} warning(s).`
        : 'Refinement applied. Refine again or start new resize.'
      const statusColor = hasWarnings ? '#d97706' : '#059669'
      setStatusAnimated(adaptationStatus, statusText, statusColor)

      syncControls()
      return
    }

    if (pluginMessage.type === 'ADAPTATION_ERROR') {
      if (session === null || pluginMessage.payload.runId !== session.runId) return

      hideProgress(progressTrack, progressFill)
      updateAiCardState(aiCard, 'error')
      pulseDots.style.display = 'none'
      setStatusAnimated(adaptationStatus, pluginMessage.payload.message, '#dc2626')

      if (session.phase === 'refining') {
        session.phase = 'ready'
      } else {
        session = null
        selectionLabel.textContent = 'Selection'
        updateSelectionState(selectionState, status)
      }
      syncControls()
    }
  }

  parent.postMessage(
    {
      pluginMessage: {
        type: 'REQUEST_ADAPTATION_REHYDRATE'
      }
    },
    '*'
  )

  /* ---- Assemble DOM ---- */
  body.appendChild(selectionCard)
  body.appendChild(settingsCard)
  body.appendChild(aiCard)

  container.appendChild(header)
  container.appendChild(headerDivider)
  container.appendChild(body)
  container.appendChild(footer)

  rootNode.appendChild(container)
}

/* ------------------------------------------------------------------ */
/*  Selection & controls helpers                                       */
/* ------------------------------------------------------------------ */

function updateSelectionState(
  state: InitSelectionStatePayload,
  statusNode: HTMLParagraphElement
): void {
  if (state.valid) {
    statusNode.textContent = `Selected: ${state.selection.name} (${Math.round(state.selection.width)}\u00D7${Math.round(state.selection.height)})`
    statusNode.style.color = 'var(--figma-color-text, #333333)'
    return
  }

  statusNode.textContent = getInvalidSelectionMessage(state.reason)
  statusNode.style.color = '#dc2626'
}

function updateSelectionCardForSession(
  lockedSelection: SelectionInfo,
  statusNode: HTMLParagraphElement
): void {
  statusNode.textContent = `${lockedSelection.name} (${Math.round(lockedSelection.width)}\u00D7${Math.round(lockedSelection.height)})`
  statusNode.style.color = 'var(--figma-color-text, #333333)'
}

function updateAiControls(
  selState: InitSelectionStatePayload,
  currentSession: SessionState | null,
  ratioSelect: HTMLSelectElement,
  adaptButton: HTMLButtonElement,
  refineBtn: HTMLButtonElement,
  resetBtn: HTMLButtonElement,
  footerRowEl: HTMLDivElement
): void {
  if (currentSession === null) {
    adaptButton.style.display = 'block'
    footerRowEl.style.display = 'none'
    ratioSelect.disabled = false
    adaptButton.disabled = !selState.valid
    adaptButton.style.opacity = selState.valid ? '1' : '0.5'
    adaptButton.textContent = 'Resize with AI'
    return
  }

  if (currentSession.phase === 'generating') {
    adaptButton.style.display = 'block'
    footerRowEl.style.display = 'none'
    ratioSelect.disabled = true
    adaptButton.disabled = true
    adaptButton.style.opacity = '0.5'
    adaptButton.textContent = 'Generating layout...'
    return
  }

  if (currentSession.phase === 'refining') {
    adaptButton.style.display = 'none'
    footerRowEl.style.display = 'flex'
    ratioSelect.disabled = true
    refineBtn.disabled = true
    refineBtn.style.opacity = '0.5'
    refineBtn.textContent = 'Refining...'
    resetBtn.disabled = true
    resetBtn.style.opacity = '0.5'
    return
  }

  // phase === 'ready'
  adaptButton.style.display = 'none'
  footerRowEl.style.display = 'flex'
  ratioSelect.disabled = true
  refineBtn.disabled = false
  refineBtn.style.opacity = '1'
  refineBtn.textContent = currentSession.refineCount > 0
    ? `Refine again (${currentSession.refineCount} done)`
    : 'Refine'
  resetBtn.disabled = false
  resetBtn.style.opacity = '1'
}

function getInvalidSelectionMessage(reason: InvalidSelectionReason): string {
  switch (reason) {
    case 'NO_SELECTION':
      return 'Select a single frame to continue.'
    case 'MULTI_SELECTION':
      return 'Select exactly one frame.'
    case 'NOT_FRAME':
      return 'Selected layer is not a frame.'
    default:
      return 'Select a single frame to continue.'
  }
}

function createRunId(): string {
  const randomSegment = Math.random().toString(36).slice(2, 8)
  return `run-${Date.now()}-${randomSegment}`
}
