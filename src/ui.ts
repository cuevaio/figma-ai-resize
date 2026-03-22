import type {
  InitSelectionStatePayload,
  InvalidSelectionReason,
  MainToUiMessage,
  PresetId
} from './messages'

type ActiveRunState = {
  runId: string
  pass: number
  maxPasses: number
}

export default function (
  rootNode: HTMLElement | null,
  data: InitSelectionStatePayload
): void {
  if (rootNode === null) {
    return
  }

  rootNode.innerHTML = ''

  const container = document.createElement('div')
  container.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif'
  container.style.padding = '16px'
  container.style.display = 'grid'
  container.style.gap = '12px'

  const title = document.createElement('h2')
  title.textContent = 'Resize frame with AI'
  title.style.margin = '0'
  title.style.fontSize = '14px'
  title.style.fontWeight = '600'

  const status = document.createElement('p')
  status.style.margin = '0'
  status.style.fontSize = '12px'
  status.style.lineHeight = '1.4'

  const ratioLabel = document.createElement('label')
  ratioLabel.textContent = 'Aspect ratio'
  ratioLabel.style.fontSize = '12px'
  ratioLabel.style.fontWeight = '500'

  const ratioSelect = document.createElement('select')
  applyInputStyles(ratioSelect)

  for (const preset of data.presets) {
    const option = document.createElement('option')
    option.value = preset.id
    option.textContent = preset.id
    option.selected = preset.id === data.defaultPresetId
    ratioSelect.appendChild(option)
  }

  const divider = document.createElement('hr')
  divider.style.margin = '4px 0'
  divider.style.border = 'none'
  divider.style.height = '1px'
  divider.style.background = '#e5e7eb'

  const aiTitle = document.createElement('h3')
  aiTitle.textContent = 'AI resize'
  aiTitle.style.margin = '0'
  aiTitle.style.fontSize = '13px'
  aiTitle.style.fontWeight = '600'

  const backendNote = document.createElement('p')
  backendNote.textContent = 'Uses local backend proxy at http://localhost:3000'
  backendNote.style.margin = '0'
  backendNote.style.fontSize = '11px'
  backendNote.style.color = '#475569'

  const adaptButton = document.createElement('button')
  adaptButton.type = 'button'
  adaptButton.textContent = 'Resize with AI'
  applyBaseButtonStyles(adaptButton)
  adaptButton.style.border = 'none'
  adaptButton.style.background = '#0f766e'
  adaptButton.style.color = '#ffffff'
  adaptButton.style.fontWeight = '600'

  const adaptationStatus = document.createElement('p')
  adaptationStatus.style.margin = '0'
  adaptationStatus.style.fontSize = '12px'
  adaptationStatus.style.lineHeight = '1.4'
  adaptationStatus.style.color = '#334155'
  adaptationStatus.textContent = 'Ready to resize with AI.'

  let selectionState = data
  let activeRun: ActiveRunState | null = null

  updateSelectionState(selectionState, status)
  updateAiControls(selectionState, activeRun, ratioSelect, adaptButton)

  adaptButton.addEventListener('click', () => {
    if (!selectionState.valid || activeRun !== null) {
      return
    }

    const runId = createRunId()
    activeRun = {
      runId,
      pass: 0,
      maxPasses: 4
    }
    updateAiControls(selectionState, activeRun, ratioSelect, adaptButton)
    adaptationStatus.textContent = 'Starting adaptation...'
    adaptationStatus.style.color = '#334155'

    parent.postMessage(
      {
        pluginMessage: {
          type: 'START_ADAPTATION',
          payload: {
            runId,
            presetId: ratioSelect.value as PresetId,
            includeScreenshot: true,
            maxPasses: 4
          }
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
      selectionState = pluginMessage.payload
      updateSelectionState(selectionState, status)
      updateAiControls(selectionState, activeRun, ratioSelect, adaptButton)
      return
    }

    if (pluginMessage.type === 'ADAPTATION_REHYDRATE') {
      if (pluginMessage.payload.activeRun !== null) {
        activeRun = {
          runId: pluginMessage.payload.activeRun.runId,
          pass: pluginMessage.payload.activeRun.pass,
          maxPasses: pluginMessage.payload.activeRun.maxPasses
        }
        adaptationStatus.textContent = pluginMessage.payload.activeRun.message
        adaptationStatus.style.color =
          pluginMessage.payload.activeRun.stage === 'FAILED' ? '#b91c1c' : '#334155'
      }

      updateAiControls(selectionState, activeRun, ratioSelect, adaptButton)
      return
    }

    if (pluginMessage.type === 'ADAPTATION_STATE') {
      if (activeRun === null) {
        activeRun = {
          runId: pluginMessage.payload.runId,
          pass: pluginMessage.payload.pass,
          maxPasses: pluginMessage.payload.maxPasses
        }
      }

      if (pluginMessage.payload.runId !== activeRun.runId) {
        return
      }

      activeRun.pass = pluginMessage.payload.pass
      activeRun.maxPasses = pluginMessage.payload.maxPasses

      adaptationStatus.textContent = pluginMessage.payload.message
      adaptationStatus.style.color = pluginMessage.payload.stage === 'FAILED' ? '#b91c1c' : '#334155'

      if (pluginMessage.payload.stage === 'COMPLETED') {
        adaptationStatus.style.color = '#065f46'
        activeRun = null
      }

      if (pluginMessage.payload.stage === 'FAILED' || pluginMessage.payload.stage === 'IDLE') {
        activeRun = null
      }

      updateAiControls(selectionState, activeRun, ratioSelect, adaptButton)
      return
    }

    if (pluginMessage.type === 'APPLY_RESULT') {
      if (activeRun === null) {
        activeRun = {
          runId: pluginMessage.payload.runId,
          pass: pluginMessage.payload.pass,
          maxPasses: pluginMessage.payload.maxPasses
        }
      }

      if (pluginMessage.payload.runId !== activeRun.runId) {
        return
      }

      if (pluginMessage.payload.isFinalPass) {
        if (pluginMessage.payload.warnings.length > 0) {
          adaptationStatus.textContent = `Layout applied with ${pluginMessage.payload.warnings.length} warning(s).`
          adaptationStatus.style.color = '#92400e'
        } else {
          adaptationStatus.textContent = 'Layout applied successfully.'
          adaptationStatus.style.color = '#065f46'
        }
        activeRun = null
        updateAiControls(selectionState, activeRun, ratioSelect, adaptButton)
        return
      }

      adaptationStatus.textContent = `Pass ${pluginMessage.payload.pass}/${pluginMessage.payload.maxPasses} done. Finalizing...`
      adaptationStatus.style.color = '#334155'
      return
    }

    if (pluginMessage.type === 'ADAPTATION_ERROR') {
      if (activeRun === null || pluginMessage.payload.runId === activeRun.runId) {
        adaptationStatus.textContent = pluginMessage.payload.message
        adaptationStatus.style.color = '#b91c1c'
        activeRun = null
        updateAiControls(selectionState, activeRun, ratioSelect, adaptButton)
      }
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

  container.appendChild(title)
  container.appendChild(status)
  container.appendChild(ratioLabel)
  container.appendChild(ratioSelect)
  container.appendChild(divider)
  container.appendChild(aiTitle)
  container.appendChild(backendNote)
  container.appendChild(adaptButton)
  container.appendChild(adaptationStatus)

  rootNode.appendChild(container)
}

function applyInputStyles(element: HTMLSelectElement): void {
  element.style.width = '100%'
  element.style.height = '32px'
  element.style.border = '1px solid #d1d5db'
  element.style.borderRadius = '6px'
  element.style.padding = '0 8px'
}

function applyBaseButtonStyles(button: HTMLButtonElement): void {
  button.style.height = '32px'
  button.style.borderRadius = '6px'
  button.style.cursor = 'pointer'
}

function updateSelectionState(
  state: InitSelectionStatePayload,
  statusNode: HTMLParagraphElement
): void {
  if (state.valid) {
    statusNode.textContent = `Selected: ${state.selection.name} (${Math.round(state.selection.width)}x${Math.round(state.selection.height)})`
    statusNode.style.color = '#1f2937'
    return
  }

  statusNode.textContent = getInvalidSelectionMessage(state.reason)
  statusNode.style.color = '#b91c1c'
}

function updateAiControls(
  state: InitSelectionStatePayload,
  run: ActiveRunState | null,
  ratioSelect: HTMLSelectElement,
  adaptButton: HTMLButtonElement
): void {
  const isBusy = run !== null
  const canRun = state.valid && !isBusy

  ratioSelect.disabled = isBusy
  ratioSelect.style.opacity = isBusy ? '0.7' : '1'

  adaptButton.disabled = canRun === false
  adaptButton.style.opacity = canRun ? '1' : '0.6'
  adaptButton.textContent = isBusy
    ? `Running pass ${run.pass}/${run.maxPasses}`
    : 'Resize with AI'
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
