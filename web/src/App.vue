<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SurfaceData, SurfaceProfile, TipGeometry } from './lib/afmMath'
import {
  SCALE_BAR_MICRONS,
  SCALE_BAR_UNITLESS,
  SIM_X_MAX,
  SIM_X_MIN,
  SIM_Y_MAX,
  SIM_Y_MIN,
  TIP_AXES_MAX,
  TIP_AXES_MIN,
  TIP_HEIGHT,
  animationSpeedToRate,
  computeSurfaceResponse,
  computeTipGeometry,
  contaminationRandomPair,
  generateSurface,
  initialSimulationCenter,
  micronsToNormalized,
  normalizedStepToIndex,
  radiusSliderToRadius,
  xSimAxis,
} from './lib/afmMath'
import { clamp } from './lib/numberUtils'

type AnimationMode = 'Off' | 'Contact' | 'Tapping'

const surfaceOptions: SurfaceProfile[] = [
  'Square',
  'Rectangle',
  'Triangle',
  'Sine',
  'Semicircle',
  'Inverted triangle',
  'Random surface',
]

const animationOptions: AnimationMode[] = ['Off', 'Contact', 'Tapping']
const TIP_TICKS = {
  x: [-5, -2.5, 0, 2.5, 5],
  y: [-5, -2.5, 0, 2.5, 5],
}
const SIM_TICKS = {
  x: [0, 1, 2, 3, 4, 5],
  y: [0, 0.5, 1, 1.5, 2],
}
const MATLAB_COLORS = {
  axisBorder: '#9a9a9a',
  axisTick: '#5f5f5f',
  axisLabel: '#1f1f1f',
  axisBackground: '#ffffff',
  scaleBar: '#4d4d4d',
  surface: '#c9ddf1',
  tip: '#111111',
  trace: '#a2142f',
}
const AXIS_FONT = '11px "Helvetica Neue", Helvetica, Arial, sans-serif'

const selectedSurface = ref<SurfaceProfile>('Square')
const radius = ref(0.5)
const width = ref(0.5)
const contaminatedTip = ref(false)
const randomContamination = ref(false)
const shearedTip = ref(false)
const multiPeakTip = ref(false)
const animationMode = ref<AnimationMode>('Off')
const animationSpeed = ref(0.5)
const tappingStep = ref(0.5)
const skipRequested = ref(false)
const simulating = ref(false)
const randomSeed = ref(42)

const surfaceData = ref<SurfaceData>(generateSurface('Square'))
const tipPreviewGeometry = ref<TipGeometry | null>(null)
const tipSimulationBaseGeometry = ref<TipGeometry | null>(null)
const tipSimulationGeometry = ref<TipGeometry | null>(null)
const simulationCenterX = ref(SIM_X_MIN)
const simulationCenterY = ref(0)
const yCenterSim = ref<Float64Array | null>(null)
const ySurfaceImageSim = ref<Float64Array | null>(null)
const tappingPoints = ref<{ x: Float64Array; y: Float64Array } | null>(null)
const tappingStride = ref(1)
const surfaceImageProgress = ref<number | null>(null)
const tappingProgress = ref<number | null>(null)

const tipCanvasRef = ref<HTMLCanvasElement | null>(null)
const simulationCanvasRef = ref<HTMLCanvasElement | null>(null)
const imagingCanvasRef = ref<HTMLCanvasElement | null>(null)

const controlsDisabled = computed(() => simulating.value)
const contaminationAllowed = computed(
  () => contaminatedTip.value && !shearedTip.value && !multiPeakTip.value,
)
const randomToggleDisabled = computed(() => !contaminationAllowed.value || controlsDisabled.value)
const animationSpeedDisabled = computed(() => animationMode.value === 'Off' || controlsDisabled.value)
const tappingDisabled = computed(() => animationMode.value !== 'Tapping' || controlsDisabled.value)
const skipDisabled = computed(() => animationMode.value === 'Off' || !simulating.value)

const effectiveRadiusSlider = computed(() => (shearedTip.value || multiPeakTip.value ? 0.5 : radius.value))
const effectiveWidthSlider = computed(() => (shearedTip.value || multiPeakTip.value ? 0.5 : width.value))

function captureRandomSeed() {
  randomSeed.value = (Date.now() ^ Math.floor(Math.random() * 100000)) >>> 0
}

function resetControls() {
  radius.value = 0.5
  width.value = 0.5
  selectedSurface.value = 'Square'
  contaminatedTip.value = false
  randomContamination.value = false
  shearedTip.value = false
  multiPeakTip.value = false
  animationMode.value = 'Off'
  animationSpeed.value = 0.5
  tappingStep.value = 0.5
  skipRequested.value = false
  captureRandomSeed()
  clearSimulationData()
  updateSurface(selectedSurface.value)
}

function clearSimulationData() {
  yCenterSim.value = null
  ySurfaceImageSim.value = null
  tappingPoints.value = null
  tappingStride.value = 1
  surfaceImageProgress.value = null
  tappingProgress.value = null
  skipRequested.value = false
}

watch(selectedSurface, (profile) => {
  updateSurface(profile)
})

watch([radius, width], () => {
  captureRandomSeed()
  clearSimulationData()
  updateTipGeometry()
})

watch(contaminatedTip, (val) => {
  if (!val) {
    randomContamination.value = false
  }
  captureRandomSeed()
  clearSimulationData()
  updateTipGeometry()
})

watch(randomContamination, () => {
  captureRandomSeed()
  clearSimulationData()
  updateTipGeometry()
})

watch(shearedTip, (val) => {
  if (val) {
    multiPeakTip.value = false
    contaminatedTip.value = false
    radius.value = 0.5
    width.value = 0.5
  }
  captureRandomSeed()
  clearSimulationData()
  updateTipGeometry()
})

watch(multiPeakTip, (val) => {
  if (val) {
    shearedTip.value = false
    contaminatedTip.value = false
    radius.value = 0.5
    width.value = 0.5
  }
  captureRandomSeed()
  clearSimulationData()
  updateTipGeometry()
})

watch(animationMode, () => {
  clearSimulationData()
  refreshCanvases()
})

watch(animationSpeed, () => {
  if (animationMode.value !== 'Off') {
    clearSimulationData()
  }
})

watch(tappingStep, () => {
  if (animationMode.value === 'Tapping') {
    clearSimulationData()
  }
})

function updateSurface(profile: SurfaceProfile) {
  surfaceData.value = generateSurface(profile)
  clearSimulationData()
  updateTipGeometry()
  refreshCanvases()
}

function updateTipGeometry() {
  const randomPair = contaminationRandomPair(
    effectiveWidthSlider.value,
    contaminationAllowed.value && randomContamination.value,
    randomSeed.value,
  )
  const tipRadiusNorm = radiusSliderToRadius(effectiveRadiusSlider.value)
  const previewCenterX = (TIP_AXES_MIN + TIP_AXES_MAX) / 2
  const previewCenterY = (TIP_AXES_MIN + TIP_AXES_MAX) / 2 - 0.5 * TIP_HEIGHT + tipRadiusNorm

  tipPreviewGeometry.value = computeTipGeometry({
    radiusSlider: effectiveRadiusSlider.value,
    widthSlider: effectiveWidthSlider.value,
    centerX: previewCenterX,
    centerY: previewCenterY,
    contaminatedTip: contaminationAllowed.value,
    randomPair,
    shearedTip: shearedTip.value,
    multiplePeaksTip: multiPeakTip.value,
  })

  const surfaceMax = arrayMax(surfaceData.value.ySurface)
  const center = initialSimulationCenter(tipPreviewGeometry.value.tipRadius, surfaceMax)
  simulationCenterX.value = center.x
  simulationCenterY.value = center.y

  tipSimulationBaseGeometry.value = computeTipGeometry({
    radiusSlider: effectiveRadiusSlider.value,
    widthSlider: effectiveWidthSlider.value,
    centerX: center.x,
    centerY: center.y,
    contaminatedTip: contaminationAllowed.value,
    randomPair,
    shearedTip: shearedTip.value,
    multiplePeaksTip: multiPeakTip.value,
  })
  tipSimulationGeometry.value = tipSimulationBaseGeometry.value

  refreshCanvases()
}

async function runSimulation() {
  if (!tipSimulationBaseGeometry.value) {
    updateTipGeometry()
  }
  if (!tipSimulationBaseGeometry.value) {
    return
  }

  simulating.value = true
  skipRequested.value = false

  const result = computeSurfaceResponse(
    tipSimulationBaseGeometry.value.ytip,
    surfaceData.value.ySurfaceImaging,
    simulationCenterY.value,
    tipSimulationBaseGeometry.value.yTipDist,
  )

  yCenterSim.value = result.yCenter
  ySurfaceImageSim.value = result.ySurfaceImage
  surfaceImageProgress.value = null
  tappingPoints.value = null
  tappingProgress.value = null

  if (animationMode.value === 'Tapping') {
    const stepNorm = micronsToNormalized(tappingStep.value)
    const stepIndex = Math.max(1, normalizedStepToIndex(stepNorm))
    tappingStride.value = stepIndex
    const xValues: number[] = []
    const yValues: number[] = []
    for (let i = 0; i < xSimAxis.length; i += stepIndex) {
      xValues.push(axisValue(i))
      yValues.push(result.ySurfaceImage[i])
    }
    tappingPoints.value = {
      x: Float64Array.from(xValues),
      y: Float64Array.from(yValues),
    }
    tappingProgress.value = 0
  }

  refreshCanvases()

  if (animationMode.value === 'Off') {
    simulating.value = false
    return
  }

  if (animationMode.value === 'Contact') {
    await playContactAnimation(result)
  } else {
    await playTappingAnimation(result)
  }

  finalizeAnimation(result)
  simulating.value = false
  skipRequested.value = false
  refreshCanvases()
}

function requestSkip() {
  skipRequested.value = true
}

async function playContactAnimation(result: { yCenter: Float64Array }) {
  if (!tipSimulationBaseGeometry.value) return
  const baseCenter = { x: simulationCenterX.value, y: simulationCenterY.value }
  const baseGeom = tipSimulationBaseGeometry.value
  const frameInterval = 1000 / animationSpeedToRate(animationSpeed.value)
  const stride = Math.max(1, Math.round(5 - 4 * animationSpeed.value))
  surfaceImageProgress.value = 0

  await animateVerticalApproach(baseGeom, baseCenter, result.yCenter[0], frameInterval)

  for (let i = 0; i < result.yCenter.length; i += stride) {
    if (skipRequested.value) break
    updateAnimatedTip(baseGeom, baseCenter, axisValue(i), result.yCenter[i])
    surfaceImageProgress.value = i
    refreshCanvases()
    await delay(frameInterval)
  }
}

async function playTappingAnimation(result: { yCenter: Float64Array }) {
  if (!tipSimulationBaseGeometry.value || !tappingPoints.value) return
  const baseCenter = { x: simulationCenterX.value, y: simulationCenterY.value }
  const baseGeom = tipSimulationBaseGeometry.value
  const frameInterval = 1000 / animationSpeedToRate(animationSpeed.value)

  let currentY = baseCenter.y

  const len = tappingPoints.value.x.length
  const stride = tappingStride.value || 1
  for (let i = 0; i < len; i += 1) {
    if (skipRequested.value) break
    const globalIndex = Math.min(i * stride, result.yCenter.length - 1)
    const targetX = tappingPoints.value.x[i]
    const targetY = result.yCenter[globalIndex]

    updateAnimatedTip(baseGeom, baseCenter, targetX, currentY)
    refreshCanvases()
    await delay(frameInterval * 0.6)

    updateAnimatedTip(baseGeom, baseCenter, targetX, targetY)
    refreshCanvases()
    await delay(frameInterval * 0.6)

    updateAnimatedTip(baseGeom, baseCenter, targetX, currentY)
    refreshCanvases()
    await delay(frameInterval * 0.6)

    currentY = baseCenter.y
    tappingProgress.value = i + 1
    surfaceImageProgress.value = globalIndex
  }
}

async function animateVerticalApproach(
  baseGeom: TipGeometry,
  baseCenter: { x: number; y: number },
  targetY: number,
  frameInterval: number,
) {
  const steps = 24
  for (let i = 1; i <= steps; i += 1) {
    if (skipRequested.value) break
    const t = i / steps
    const y = baseCenter.y + t * (targetY - baseCenter.y)
    updateAnimatedTip(baseGeom, baseCenter, baseCenter.x, y)
    refreshCanvases()
    await delay(frameInterval * 0.6)
  }
}

function updateAnimatedTip(
  baseGeom: TipGeometry,
  baseCenter: { x: number; y: number },
  targetX: number,
  targetY: number,
) {
  tipSimulationGeometry.value = translateTipGeometry(baseGeom, baseCenter, targetX, targetY)
}

function translateTipGeometry(
  baseGeom: TipGeometry,
  baseCenter: { x: number; y: number },
  targetX: number,
  targetY: number,
): TipGeometry {
  const dx = targetX - baseCenter.x
  const dy = targetY - baseCenter.y
  const xtip = new Float64Array(baseGeom.xtip.length)
  const ytip = new Float64Array(baseGeom.ytip.length)
  for (let i = 0; i < baseGeom.xtip.length; i += 1) {
    xtip[i] = baseGeom.xtip[i] + dx
    ytip[i] = baseGeom.ytip[i] + dy
  }
  return {
    xtip,
    ytip,
    yTipDist: baseGeom.yTipDist,
    tipRadius: baseGeom.tipRadius,
    tipHalfWidth: baseGeom.tipHalfWidth,
  }
}

function finalizeAnimation(result: { yCenter: Float64Array }) {
  if (!tipSimulationBaseGeometry.value) return
  const baseCenter = { x: simulationCenterX.value, y: simulationCenterY.value }
  const baseGeom = tipSimulationBaseGeometry.value
  const finalX = axisValue(result.yCenter.length - 1)
  const finalY = result.yCenter[result.yCenter.length - 1]
  updateAnimatedTip(baseGeom, baseCenter, finalX, finalY)
  surfaceImageProgress.value = null
  tappingProgress.value = null
}

function arrayMax(arr: Float64Array): number {
  let max = -Infinity
  for (let i = 0; i < arr.length; i += 1) {
    const value = arr[i]
    if (value > max) {
      max = value
    }
  }
  return max
}

function axisValue(index: number): number {
  return xSimAxis[index] ?? xSimAxis[xSimAxis.length - 1] ?? SIM_X_MAX
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function refreshCanvases() {
  drawTipCanvas()
  drawSimulationCanvas()
  drawImagingCanvas()
}

function withContext(
  canvas: HTMLCanvasElement | null,
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
) {
  if (!canvas) return
  const width = canvas.clientWidth || 1
  const height = canvas.clientHeight || 1
  const dpr = window.devicePixelRatio || 1
  canvas.width = width * dpr
  canvas.height = height * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, width, height)
  draw(ctx, width, height)
  ctx.restore()
}

function drawTipCanvas() {
  withContext(tipCanvasRef.value, (ctx, width, height) => {
    const bounds = { xMin: TIP_AXES_MIN, xMax: TIP_AXES_MAX, yMin: TIP_AXES_MIN, yMax: TIP_AXES_MAX }
    drawAxes(ctx, width, height)
    if (tipPreviewGeometry.value) {
      drawTipShape(ctx, width, height, tipPreviewGeometry.value, bounds)
    }
    drawScaleBar(ctx, width, height, 'tip')
    drawAxisTicks(ctx, width, height, bounds, TIP_TICKS)
  })
}

function drawSimulationCanvas() {
  withContext(simulationCanvasRef.value, (ctx, width, height) => {
    const bounds = { xMin: SIM_X_MIN, xMax: SIM_X_MAX, yMin: SIM_Y_MIN, yMax: SIM_Y_MAX }
    drawAxes(ctx, width, height)
    drawSurfacePatch(ctx, width, height, surfaceData.value)
    if (tipSimulationGeometry.value) {
      drawTipShape(ctx, width, height, tipSimulationGeometry.value, {
        xMin: SIM_X_MIN,
        xMax: SIM_X_MAX,
        yMin: SIM_Y_MIN,
        yMax: SIM_Y_MAX,
      })
    }
    if (ySurfaceImageSim.value) {
      drawSurfaceImage(ctx, width, height, ySurfaceImageSim.value, 'line', surfaceImageProgress.value)
      if (animationMode.value === 'Tapping' && tappingPoints.value) {
        drawTappingPoints(ctx, width, height, tappingPoints.value, tappingProgress.value)
      }
    }
    drawScaleBar(ctx, width, height, 'simulation')
    drawAxisTicks(ctx, width, height, bounds, SIM_TICKS)
  })
}

function drawImagingCanvas() {
  withContext(imagingCanvasRef.value, (ctx, width, height) => {
    const bounds = { xMin: SIM_X_MIN, xMax: SIM_X_MAX, yMin: SIM_Y_MIN, yMax: SIM_Y_MAX }
    drawAxes(ctx, width, height)
    if (ySurfaceImageSim.value) {
      if (animationMode.value === 'Tapping' && tappingPoints.value) {
        drawTappingPoints(ctx, width, height, tappingPoints.value, tappingProgress.value)
      } else {
        drawSurfaceImage(ctx, width, height, ySurfaceImageSim.value, 'line', surfaceImageProgress.value)
      }
    }
    drawScaleBar(ctx, width, height, 'simulation')
    drawAxisTicks(ctx, width, height, bounds, SIM_TICKS)
  })
}

function drawAxes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  ctx.fillStyle = MATLAB_COLORS.axisBackground
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = MATLAB_COLORS.axisBorder
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, Math.max(width - 1, 0), Math.max(height - 1, 0))
}

function drawTipShape(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  geometry: TipGeometry,
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
) {
  ctx.fillStyle = MATLAB_COLORS.tip
  ctx.beginPath()
  for (let i = 0; i < geometry.xtip.length; i += 1) {
    const { x, y } = toCanvasPoint(geometry.xtip[i], geometry.ytip[i], bounds, width, height)
    if (i === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  }
  ctx.closePath()
  ctx.fill()
}

function drawSurfacePatch(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  surface: SurfaceData,
) {
  const bounds = {
    xMin: SIM_X_MIN,
    xMax: SIM_X_MAX,
    yMin: SIM_Y_MIN,
    yMax: SIM_Y_MAX,
  }
  ctx.fillStyle = MATLAB_COLORS.surface
  ctx.beginPath()
  for (let i = 0; i < surface.xSurface.length; i += 1) {
    const { x, y } = toCanvasPoint(surface.xSurface[i], surface.ySurface[i], bounds, width, height)
    if (i === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  }
  ctx.closePath()
  ctx.fill()
}

function drawSurfaceImage(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  values: Float64Array,
  mode: 'line' | 'points',
  progress?: number | null,
) {
  const bounds = {
    xMin: SIM_X_MIN,
    xMax: SIM_X_MAX,
    yMin: SIM_Y_MIN,
    yMax: SIM_Y_MAX,
  }
  ctx.strokeStyle = MATLAB_COLORS.trace
  ctx.lineWidth = 1.6
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  let started = false
  const limit = progress == null ? values.length - 1 : Math.min(Math.floor(progress), values.length - 1)
  if (limit < 1) {
    return
  }
  for (let i = 0; i <= limit; i += 1) {
    const { x, y } = toCanvasPoint(axisValue(i), values[i], bounds, width, height)
    if (!Number.isFinite(y)) continue
    if (!started) {
      ctx.moveTo(x, y)
      started = true
    } else {
      ctx.lineTo(x, y)
    }
  }
  ctx.stroke()
  if (mode === 'points') {
    ctx.fillStyle = MATLAB_COLORS.trace
    for (let i = 0; i <= limit; i += 1) {
      if (i % 10 !== 0) continue
      const { x, y } = toCanvasPoint(axisValue(i), values[i], bounds, width, height)
      if (!Number.isFinite(y)) continue
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

function drawTappingPoints(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  points: { x: Float64Array; y: Float64Array },
  progress: number | null,
) {
  const bounds = {
    xMin: SIM_X_MIN,
    xMax: SIM_X_MAX,
    yMin: SIM_Y_MIN,
    yMax: SIM_Y_MAX,
  }
  const limit = progress == null ? points.x.length : Math.min(Math.floor(progress), points.x.length)
  ctx.strokeStyle = MATLAB_COLORS.trace
  ctx.fillStyle = MATLAB_COLORS.trace
  for (let i = 0; i < limit; i += 1) {
    const { x, y } = toCanvasPoint(points.x[i], points.y[i], bounds, width, height)
    ctx.beginPath()
    ctx.arc(x, y, 3.5, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  target: 'tip' | 'simulation',
) {
  const bounds = target === 'tip'
    ? { xMin: TIP_AXES_MIN, xMax: TIP_AXES_MAX }
    : { xMin: SIM_X_MIN, xMax: SIM_X_MAX }
  const barLengthPx = (SCALE_BAR_UNITLESS / (bounds.xMax - bounds.xMin)) * width
  const barHeight = target === 'tip' ? 8 : 4
  const padding = 16
  const y = target === 'tip' ? height - padding : padding + barHeight
  const xEnd = width - padding
  const xStart = xEnd - barLengthPx
  ctx.fillStyle = MATLAB_COLORS.scaleBar
  ctx.fillRect(xStart, y - barHeight, barLengthPx, barHeight)
  ctx.fillStyle = MATLAB_COLORS.axisLabel
  ctx.font = AXIS_FONT
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillText(`${SCALE_BAR_MICRONS.toFixed(1)} µm`, xStart - 6, y - barHeight / 2)
}

function drawAxisTicks(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  ticks: { x: number[]; y: number[] },
) {
  ctx.strokeStyle = MATLAB_COLORS.axisTick
  ctx.fillStyle = MATLAB_COLORS.axisLabel
  ctx.lineWidth = 1
  ctx.font = AXIS_FONT

  const tickLength = 6
  const xLabelOffset = 12
  const yLabelOffset = 4

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ticks.x.forEach((tick) => {
    if (tick < bounds.xMin || tick > bounds.xMax) return
    const x = toCanvasX(tick, bounds, width)
    ctx.beginPath()
    ctx.moveTo(x, height - 1)
    ctx.lineTo(x, height - 1 - tickLength)
    ctx.stroke()
    ctx.fillText(formatTick(tick), x, height - 1 - tickLength - xLabelOffset)
  })

  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ticks.y.forEach((tick) => {
    if (tick < bounds.yMin || tick > bounds.yMax) return
    const y = toCanvasY(tick, bounds, height)
    ctx.beginPath()
    ctx.moveTo(1, y)
    ctx.lineTo(1 + tickLength, y)
    ctx.stroke()
    ctx.fillText(formatTick(tick), 1 + tickLength + yLabelOffset, y)
  })
}

function formatTick(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Math.abs(rounded % 1) < 1e-6 ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1)}`
}

function toCanvasX(
  x: number,
  bounds: { xMin: number; xMax: number },
  width: number,
) {
  const xRatio = clamp((x - bounds.xMin) / (bounds.xMax - bounds.xMin), 0, 1)
  return xRatio * width
}

function toCanvasY(
  y: number,
  bounds: { yMin: number; yMax: number },
  height: number,
) {
  const yRatio = clamp((y - bounds.yMin) / (bounds.yMax - bounds.yMin), 0, 1)
  return height - yRatio * height
}

function toCanvasPoint(
  x: number,
  y: number,
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  width: number,
  height: number,
) {
  return {
    x: toCanvasX(x, bounds, width),
    y: toCanvasY(y, bounds, height),
  }
}

function handleResize() {
  refreshCanvases()
}

onMounted(() => {
  updateTipGeometry()
  window.addEventListener('resize', handleResize)
  refreshCanvases()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
})
</script>

<template>
  <q-layout view="lHh Lpr lFf">
    <q-page-container>
      <q-page class="afm-page">
        <div class="afm-layout">
          <section class="afm-left">
            <q-card flat bordered class="tip-card matlab-card">
              <div class="section-title">Tip Shape</div>
              <div class="tip-body">
                <canvas ref="tipCanvasRef"></canvas>
              </div>
            </q-card>

            <q-card flat bordered class="control-card matlab-card">
              <div class="section-title">Surface profiles</div>
              <q-option-group
                v-model="selectedSurface"
                :options="surfaceOptions.map((value) => ({ label: value, value }))"
                type="radio"
                color="primary"
                :disable="controlsDisabled"
              />
            </q-card>

            <q-card flat bordered class="control-card matlab-card">
              <div class="section-title">Tip geometry</div>
              <div class="slider-label">Radius</div>
              <q-slider
                v-model="radius"
                :min="0"
                :max="1"
                :step="0.01"
                markers
                color="primary"
                :disable="controlsDisabled || shearedTip || multiPeakTip"
              />

              <div class="slider-label">Width</div>
              <q-slider
                v-model="width"
                :min="0"
                :max="1"
                :step="0.01"
                markers
                color="primary"
                :disable="controlsDisabled || shearedTip || multiPeakTip"
              />

              <div class="row q-col-gutter-xs q-mt-sm">
                <div class="col-6">
                  <q-toggle
                    v-model="contaminatedTip"
                    label="Contaminated tip"
                    :disable="controlsDisabled || shearedTip || multiPeakTip"
                    dense
                  />
                </div>
                <div class="col-6">
                  <q-toggle
                    v-model="randomContamination"
                    label="Random"
                    :disable="randomToggleDisabled"
                    dense
                  />
                </div>
                <div class="col-6">
                  <q-toggle v-model="shearedTip" label="Sheared tip" :disable="controlsDisabled" dense />
                </div>
                <div class="col-6">
                  <q-toggle
                    v-model="multiPeakTip"
                    label="Multiple peaks"
                    :disable="controlsDisabled"
                    dense
                  />
                </div>
              </div>
            </q-card>

            <q-card flat bordered class="control-card animation-card matlab-card">
              <div class="section-title">Animation</div>
              <div class="animation-block">
                <q-select
                  v-model="animationMode"
                  :options="animationOptions"
                  dense
                  outlined
                  class="full-width"
                  :disable="controlsDisabled"
                />
              </div>

              <div class="slider-label">Animation speed</div>
              <q-slider
                v-model="animationSpeed"
                :min="0"
                :max="1"
                :step="0.01"
                markers
                color="secondary"
                :disable="animationSpeedDisabled"
              />

              <div class="tapping-input" :class="{ 'tapping-input--hidden': animationMode !== 'Tapping' }">
                <q-input
                  v-model.number="tappingStep"
                  type="number"
                  label="Tapping step size (µm)"
                  dense
                  outlined
                  suffix="µm"
                  :min="0.5"
                  :max="20"
                  :step="0.5"
                  :disable="tappingDisabled"
                />
              </div>
            </q-card>

            <div class="action-block">
              <q-btn
                unelevated
                color="primary"
                label="Run"
                class="full-width matlab-btn"
                :loading="simulating"
                :disable="controlsDisabled"
                @click="runSimulation"
              />
              <q-btn
                color="primary"
                label="Reset"
                class="full-width matlab-btn"
                :disable="controlsDisabled"
                @click="resetControls"
              />
              <q-btn
                color="negative"
                label="Skip animation"
                class="full-width matlab-btn matlab-btn--danger"
                :disable="skipDisabled"
                @click="requestSkip"
              />
            </div>
          </section>

          <section class="afm-right">
            <q-card flat bordered class="plot-card matlab-card">
              <div class="plot-header">Simulation</div>
              <div class="plot-body">
                <canvas ref="simulationCanvasRef"></canvas>
              </div>
            </q-card>

            <q-card flat bordered class="plot-card matlab-card">
              <div class="plot-header">Surface Imaging</div>
              <div class="plot-body">
                <canvas ref="imagingCanvasRef"></canvas>
              </div>
            </q-card>
          </section>
        </div>
      </q-page>
    </q-page-container>
  </q-layout>
</template>

<style scoped>
.afm-page {
  min-height: 100vh;
  padding: 12px 16px 24px;
  background: var(--matlab-bg);
}

.afm-layout {
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 12px;
  max-width: 1500px;
  margin: 0 auto;
}

.afm-left {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.tip-card,
.control-card {
  padding: 10px 12px 12px;
}

.tip-body {
  height: 210px;
  background: #ffffff;
  border: 1px solid var(--matlab-panel-border);
}

.control-card.animation-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.animation-block {
  margin-bottom: 8px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--matlab-text);
}

.slider-label {
  font-size: 12px;
  font-weight: 500;
  margin-top: 8px;
}

.action-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.full-width {
  width: 100%;
}

.afm-right {
  display: grid;
  grid-template-rows: repeat(2, minmax(300px, 1fr));
  gap: 16px;
}

.plot-card {
  display: flex;
  flex-direction: column;
}

.plot-header {
  padding: 8px 12px;
  font-weight: 600;
  font-size: 13px;
  border-bottom: 1px solid var(--matlab-panel-border);
}

.plot-body {
  flex: 1;
  padding: 12px;
  background: #ffffff;
}

.matlab-card {
  background: var(--matlab-panel);
  border-color: var(--matlab-panel-border);
  border-radius: 2px;
  box-shadow: none;
}

.matlab-btn {
  background: linear-gradient(#fafafa, #e3e3e3);
  color: var(--matlab-text);
  border: 1px solid var(--matlab-panel-border);
  border-radius: 2px;
  text-transform: none;
  font-weight: 500;
  box-shadow: none;
}

.matlab-btn--danger {
  color: #a2142f;
}

.tapping-input--hidden {
  visibility: hidden;
}

:deep(.q-btn.matlab-btn) {
  min-height: 32px;
}

:deep(.q-option-group) {
  row-gap: 4px;
}

:deep(.q-item) {
  min-height: 24px;
}

:deep(.q-radio__inner),
:deep(.q-toggle__inner) {
  transform: scale(0.9);
}

:deep(.q-field--outlined .q-field__control) {
  border-radius: 2px;
}

:deep(.q-slider__track) {
  background: #c8c8c8;
}

:deep(.q-slider__thumb) {
  border: 1px solid #7a7a7a;
}

canvas {
  width: 100%;
  height: 100%;
  display: block;
}

@media (max-width: 1200px) {
  .afm-layout {
    grid-template-columns: 1fr;
  }

  .afm-right {
    grid-template-rows: repeat(2, 320px);
  }
}
</style>
