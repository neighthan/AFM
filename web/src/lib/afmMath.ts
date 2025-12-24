import { clamp, lerp } from './numberUtils'

export type SurfaceProfile =
  | 'Square'
  | 'Rectangle'
  | 'Triangle'
  | 'Sine'
  | 'Semicircle'
  | 'Inverted triangle'
  | 'Random surface'

export interface SurfaceData {
  xSurface: Float64Array
  ySurface: Float64Array
  ySurfaceImaging: Float64Array
}

export interface TipGeometry {
  xtip: Float64Array
  ytip: Float64Array
  yTipDist: number
  tipRadius: number
  tipHalfWidth: number
}

export interface TipShapeInput {
  radiusSlider: number
  widthSlider: number
  centerX: number
  centerY: number
  contaminatedTip: boolean
  randomPair: [number, number]
  shearedTip: boolean
  multiplePeaksTip: boolean
}

export const DELTA_X = 0.001
export const TIP_HEIGHT = 6
export const MAX_HALF_WIDTH = 1.5
export const MAX_TIP_RADIUS_UNITS = 10
export const SCALE_BAR_MICRONS = 5
export const SIM_X_MIN = 0
export const SIM_X_MAX = 5
export const SIM_Y_MIN = 0
export const SIM_Y_MAX = 2
export const TIP_AXES_MIN = -5
export const TIP_AXES_MAX = 5
const BASE = 50
export const MAX_TIP_RADIUS = radiusSliderToRadius(1)

export const xSimAxis = createAxis(SIM_X_MIN, SIM_X_MAX, DELTA_X)

export function createAxis(start: number, end: number, step: number): Float64Array {
  const len = Math.round((end - start) / step) + 1
  const arr = new Float64Array(len)
  for (let i = 0; i < len; i += 1) {
    arr[i] = start + i * step
  }
  return arr
}

export function radiusSliderToRadius(value: number): number {
  return (Math.pow(BASE, value) - 1) / (BASE - 1)
}

export function widthSliderToHalfWidth(value: number, tipRadius: number): number {
  return tipRadius + (MAX_HALF_WIDTH - tipRadius) * value
}

export function animationSpeedToRate(value: number): number {
  const slow = 80
  const fast = 1000
  return slow + (fast - slow) * value
}
const DEFAULT_RANDOM_SMALL: [number, number] = [0.9, 0.2]
const DEFAULT_RANDOM_LARGE: [number, number] = [0.9, 0.3]

export function contaminationRandomPair(
  widthSliderValue: number,
  randomEnabled: boolean,
  seed: number,
): [number, number] {
  if (!randomEnabled) {
    return widthSliderValue <= 0.5 ? DEFAULT_RANDOM_SMALL : DEFAULT_RANDOM_LARGE
  }
  const rng = mulberry32(seed)
  return [rng(), rng()]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
interface TipBuildContext extends TipShapeInput {
  tipRadius: number
  tipHalfWidth: number
}

export function computeTipGeometry(input: TipShapeInput): TipGeometry {
  const context: TipBuildContext = {
    ...input,
    tipRadius: radiusSliderToRadius(input.radiusSlider) / MAX_TIP_RADIUS,
    tipHalfWidth: 0,
  }

  context.tipHalfWidth = widthSliderToHalfWidth(input.widthSlider, context.tipRadius)

  if (input.shearedTip || input.multiplePeaksTip) {
    const presetRadius = radiusSliderToRadius(0.5) / MAX_TIP_RADIUS
    context.tipRadius = presetRadius
    context.tipHalfWidth = widthSliderToHalfWidth(0.5, presetRadius)
  }

  if (input.shearedTip) {
    return buildShearedTip(context)
  }

  if (input.multiplePeaksTip) {
    return buildMultiplePeakTip(context)
  }

  return buildDefaultTip(context)
}
function buildDefaultTip(context: TipBuildContext): TipGeometry {
  const { centerX, centerY, tipRadius, tipHalfWidth } = context
  const tipHeightPlot = centerY - tipRadius + TIP_HEIGHT
  const cirPlotX = createAxis(centerX - tipRadius, centerX + tipRadius, DELTA_X)
  const cirPlotY = new Float64Array(cirPlotX.length)
  for (let i = 0; i < cirPlotX.length; i += 1) {
    const dx = cirPlotX[i] - centerX
    const inner = Math.max(tipRadius ** 2 - dx ** 2, 0)
    cirPlotY[i] = -Math.sqrt(inner) + centerY
  }

  if (tipRadius === 0 && tipHalfWidth === tipRadius) {
    const xtip = new Float64Array(cirPlotX.length * 2)
    const ytip = new Float64Array(cirPlotX.length * 2)
    xtip.set(cirPlotX)
    xtip.set(cirPlotX, cirPlotX.length)
    ytip.set(cirPlotY)
    ytip.set(new Float64Array(cirPlotX.length).fill(tipHeightPlot), cirPlotX.length)
    return { xtip, ytip, yTipDist: tipRadius, tipRadius, tipHalfWidth }
  }

  const left = tipLine([centerX - tipHalfWidth, tipHeightPlot], [cirPlotX[0], cirPlotY[0]], context)
  const right = tipLine(
    [cirPlotX[cirPlotX.length - 1], cirPlotY[cirPlotY.length - 1]],
    [centerX + tipHalfWidth, tipHeightPlot],
    context,
  )

  const middleLength = Math.max(cirPlotX.length - 2, 0)
  const totalLength = left.x.length + middleLength + right.x.length
  const xtip = new Float64Array(totalLength)
  const ytip = new Float64Array(totalLength)
  xtip.set(left.x)
  ytip.set(left.y)
  if (middleLength > 0) {
    xtip.set(cirPlotX.slice(1, cirPlotX.length - 1), left.x.length)
    ytip.set(cirPlotY.slice(1, cirPlotY.length - 1), left.x.length)
  }
  xtip.set(right.x, left.x.length + middleLength)
  ytip.set(right.y, left.x.length + middleLength)

  return { xtip, ytip, yTipDist: tipRadius, tipRadius, tipHalfWidth }
}

function buildShearedTip(context: TipBuildContext): TipGeometry {
  const { centerX, centerY, tipRadius, tipHalfWidth } = context
  const tipHeightPlot = centerY - tipRadius + TIP_HEIGHT
  const slantPlotX = createAxis(centerX - tipRadius, centerX + tipRadius, DELTA_X)
  const startY = centerY - 0.5 * tipRadius
  const endY = centerY + 0.5 * tipRadius
  const slope = (endY - startY) / (slantPlotX[slantPlotX.length - 1] - slantPlotX[0] || 1)
  const slantPlotY = new Float64Array(slantPlotX.length)
  for (let i = 0; i < slantPlotX.length; i += 1) {
    slantPlotY[i] = slope * (slantPlotX[i] - slantPlotX[0]) + startY
  }

  const left = tipLine([centerX - tipHalfWidth, tipHeightPlot], [slantPlotX[0], slantPlotY[0]], context)
  const right = tipLine(
    [slantPlotX[slantPlotX.length - 1], slantPlotY[slantPlotY.length - 1]],
    [centerX + tipHalfWidth, tipHeightPlot],
    context,
  )

  const middleLength = Math.max(slantPlotX.length - 2, 0)
  const totalLength = left.x.length + middleLength + right.x.length
  const xtip = new Float64Array(totalLength)
  const ytip = new Float64Array(totalLength)
  xtip.set(left.x)
  ytip.set(left.y)
  if (middleLength > 0) {
    xtip.set(slantPlotX.slice(1, slantPlotX.length - 1), left.x.length)
    ytip.set(slantPlotY.slice(1, slantPlotY.length - 1), left.x.length)
  }
  xtip.set(right.x, left.x.length + middleLength)
  ytip.set(right.y, left.x.length + middleLength)

  return { xtip, ytip, yTipDist: 0.5 * tipRadius, tipRadius, tipHalfWidth }
}

function buildMultiplePeakTip(context: TipBuildContext): TipGeometry {
  const { centerX, centerY, tipRadius, tipHalfWidth } = context
  const tipHeightPlot = centerY - tipRadius + TIP_HEIGHT
  const quarticX = createAxis(centerX - tipRadius, centerX + tipRadius, DELTA_X)
  const quarticY = new Float64Array(quarticX.length)
  const a = 500
  const b = 20
  const c = -12
  for (let i = 0; i < quarticX.length; i += 1) {
    const x = quarticX[i]
    quarticY[i] = a * x ** 4 + b * x ** 3 + c * x ** 2 + centerY
  }

  const left = tipLine([centerX - tipHalfWidth, tipHeightPlot], [quarticX[0], quarticY[0]], context)
  const right = tipLine(
    [quarticX[quarticX.length - 1], quarticY[quarticY.length - 1]],
    [centerX + tipHalfWidth, tipHeightPlot],
    context,
  )

  const middleLength = Math.max(quarticX.length - 2, 0)
  const totalLength = left.x.length + middleLength + right.x.length
  const xtip = new Float64Array(totalLength)
  const ytip = new Float64Array(totalLength)
  xtip.set(left.x)
  ytip.set(left.y)
  if (middleLength > 0) {
    xtip.set(quarticX.slice(1, quarticX.length - 1), left.x.length)
    ytip.set(quarticY.slice(1, quarticY.length - 1), left.x.length)
  }
  xtip.set(right.x, left.x.length + middleLength)
  ytip.set(right.y, left.x.length + middleLength)

  const minValue = quarticY.reduce((min, val) => Math.min(min, val), quarticY[0])
  return { xtip, ytip, yTipDist: Math.abs(minValue - centerY), tipRadius, tipHalfWidth }
}

function tipLine(
  start: [number, number],
  end: [number, number],
  context: TipBuildContext,
): { x: Float64Array; y: Float64Array } {
  let [startX, startY] = start
  let [endX, endY] = end
  if (endX - startX < DELTA_X) {
    endX = startX
  }

  let xline: number[] = []
  let yline: number[] = []

  if (startX < endX) {
    const steps = Math.max(1, Math.round((endX - startX) / DELTA_X))
    xline = new Array(steps + 1)
    yline = new Array(steps + 1)
    for (let i = 0; i <= steps; i += 1) {
      const ratio = i / steps
      const x = startX + ratio * (endX - startX)
      xline[i] = x
      yline[i] = startY + ratio * (endY - startY)
    }
  } else {
    const numPts = 20
    xline = new Array(numPts)
    yline = new Array(numPts)
    for (let i = 0; i < numPts; i += 1) {
      const ratio = i / (numPts - 1)
      xline[i] = startX
      yline[i] = startY + ratio * (endY - startY)
    }
  }

  let yProcessed = yline
  if (context.contaminatedTip) {
    yProcessed = contaminateLine(
      xline,
      yline,
      context.tipRadius,
      context.tipHalfWidth,
      context.randomPair,
    )
  }

  return { x: Float64Array.from(xline), y: Float64Array.from(yProcessed) }
}

function contaminateLine(
  xline: number[],
  yline: number[],
  tipRadius: number,
  tipHalfWidth: number,
  randPair: [number, number],
): number[] {
  if (xline.length < 2) {
    return yline
  }
  const dist = totalDistance(xline, yline)
  if (dist === 0) {
    return yline
  }

  const slopes: number[] = []
  for (let i = 0; i < xline.length - 1; i += 1) {
    const dx = xline[i + 1] - xline[i]
    if (dx === 0) continue
    slopes.push((yline[i + 1] - yline[i]) / dx)
  }
  if (slopes.length === 0) {
    return yline
  }

  const m = Math.max(...slopes)
  if (m === 0) {
    return yline
  }

  const fracMin = fracFunction(tipRadius, MAX_HALF_WIDTH, 0.014, 0.1, tipHalfWidth)
  const fracMax = fracFunction(tipRadius, MAX_HALF_WIDTH, 0.017, 0.25, tipHalfWidth)
  const lambdaMin = fracMin * dist
  const lambdaMax = fracMax * dist
  const randValue = m < 0 ? randPair[0] : randPair[1]
  const lambda = lambdaMin + (lambdaMax - lambdaMin) * randValue
  if (lambda === 0) {
    return yline
  }

  const amp = lerp(1, 0.5, clamp((tipHalfWidth - tipRadius) / (MAX_HALF_WIDTH - tipRadius || 1), 0, 1))
  const anchorIndex = m < 0 ? xline.length - 1 : 0
  const anchor = xline[anchorIndex]
  const contaminated = yline.map((y, idx) => {
    const shift = xline[idx] - anchor
    const perturb = -amp * Math.sin((2 * Math.PI * shift) / lambda) ** 2
    return y + perturb
  })
  contaminated[0] = yline[0]
  contaminated[contaminated.length - 1] = yline[yline.length - 1]
  return contaminated
}

function totalDistance(xline: number[], yline: number[]): number {
  let dist = 0
  for (let i = 0; i < xline.length - 1; i += 1) {
    const dx = xline[i + 1] - xline[i]
    const dy = yline[i + 1] - yline[i]
    dist += Math.sqrt(dx * dx + dy * dy)
  }
  return dist
}

function fracFunction(
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number,
  x: number,
): number {
  const x1 = xMin
  const x5 = xMax
  const y1 = yMin
  const y5 = yMax
  const x3 = (x1 + x5) / 2
  const y3 = y5 - 0.1 * (y5 - y1)
  const x2 = (x1 + x3) / 2
  const y2 = y3 - 0.2 * (y3 - y1)
  const x4 = (x3 + x5) / 2
  const y4 = (y3 + y5) / 2
  const xVec = [x1, x2, x3, x4, x5]
  const yVec = [y1, y2, y3, y4, y5]
  return lagrangeInterpolation(x, xVec, yVec)
}

function lagrangeInterpolation(x: number, xs: number[], ys: number[]): number {
  let sum = 0
  for (let i = 0; i < xs.length; i += 1) {
    let term = ys[i]
    for (let j = 0; j < xs.length; j += 1) {
      if (i === j) continue
      term *= (x - xs[j]) / (xs[i] - xs[j])
    }
    sum += term
  }
  return sum
}
export function generateSurface(profile: SurfaceProfile): SurfaceData {
  switch (profile) {
    case 'Square':
      return squareSurface()
    case 'Rectangle':
      return rectangleSurface()
    case 'Triangle':
      return triangleSurface()
    case 'Sine':
      return sineSurface()
    case 'Semicircle':
      return semicircleSurface()
    case 'Inverted triangle':
      return invertedTriangleSurface()
    case 'Random surface':
      return randomSurface()
  }
}

function squareSurface(): SurfaceData {
  const numSquares = 5
  const yShift = 0.05
  const squareLen = (xSimAxis[xSimAxis.length - 1] - xSimAxis[0]) / (2 * numSquares)
  const numPts = pointsForDistance(squareLen)
  const ySquare: number[] = []
  for (let i = 0; i < numPts - 1; i += 1) {
    ySquare.push(squareLen + yShift)
  }
  for (let i = 0; i < numPts - 1; i += 1) {
    ySquare.push(0 + yShift)
  }
  const pattern = repeatPattern(ySquare, numSquares)
  return surfaceFromPattern(pattern, undefined)
}

function rectangleSurface(): SurfaceData {
  const numSquares = 5
  const yShift = 0.05
  const squareLen = (xSimAxis[xSimAxis.length - 1] - xSimAxis[0]) / (2 * numSquares)
  const numPts = pointsForDistance(squareLen)
  const yRect: number[] = []
  for (let i = 0; i < numPts - 1; i += 1) {
    yRect.push(2 * squareLen + yShift)
  }
  for (let i = 0; i < numPts - 1; i += 1) {
    yRect.push(0 + yShift)
  }
  const pattern = repeatPattern(yRect, numSquares)
  return surfaceFromPattern(pattern, undefined)
}

function triangleSurface(): SurfaceData {
  const numTriangles = 5
  const yShift = 0.05
  const totalLen = xSimAxis[xSimAxis.length - 1] - xSimAxis[0]
  const triangleLen = totalLen / numTriangles
  const halfTriangle = triangleLen / 2
  const xTriangle = createAxis(-halfTriangle, halfTriangle, DELTA_X)
  const yTriangleBase = Array.from(xTriangle, (x) => -Math.abs(x) + halfTriangle)
  const yTriangle = [...yTriangleBase, ...Array(Math.round(0.1 * xTriangle.length)).fill(0)].map(
    (val) => val + yShift,
  )
  const pattern = repeatPattern(yTriangle, numTriangles)
  return surfaceFromPattern(pattern, undefined)
}

function sineSurface(): SurfaceData {
  const amplitude = 0.25
  const numWaves = 5
  const yShift = 0.05
  const totalLen = xSimAxis[xSimAxis.length - 1] - xSimAxis[0]
  const lambda = totalLen / numWaves
  const ySurf = Array.from(xSimAxis, (x) => {
    const y = amplitude * Math.cos((2 * Math.PI * x) / lambda)
    return y + Math.abs(Math.min(-amplitude, y)) + yShift
  })
  return surfaceFromPattern(ySurf, undefined)
}

function semicircleSurface(): SurfaceData {
  const R = 0.5
  const yShift = 0.05
  const yBase = Array.from(xSimAxis, (x) => {
    const term = (2 * R / Math.PI) * Math.acos(Math.cos((Math.PI * x) / (2 * R))) - R
    return Math.sqrt(Math.max(R ** 2 - term ** 2, 0))
  })
  const maxVal = Math.max(...yBase)
  const ySurf = yBase.map((val) => -val + maxVal + yShift)
  return surfaceFromPattern(ySurf, undefined)
}

function invertedTriangleSurface(): SurfaceData {
  const numTriangles = 5
  const yShift = 0.05
  const totalLen = xSimAxis[xSimAxis.length - 1] - xSimAxis[0]
  const triangleLen = totalLen / numTriangles
  const halfTriangle = triangleLen / 2
  const xTriangle = createAxis(-halfTriangle, halfTriangle, DELTA_X)
  let yTriangle = Array.from(xTriangle, (x) => Math.abs(x))
  const maxVal = Math.max(...yTriangle)
  yTriangle = yTriangle.map((val) => val - 0.1 * maxVal)

  const halfIdx = Math.floor(0.5 * yTriangle.length)
  const xTriangleLeftBase = Array.from(xSimAxis.slice(0, halfIdx))
  const xTriangleRightBase = Array.from(
    xSimAxis.slice(halfIdx, halfIdx + (yTriangle.length - halfIdx)),
  )
  const yTriangleLeftBase = yTriangle.slice(0, halfIdx)
  const yTriangleRightBase = yTriangle.slice(halfIdx)

  const left = filterByMask(xTriangleLeftBase, yTriangleLeftBase, (val) => val >= 0)
  const right = filterByMask(xTriangleRightBase, yTriangleRightBase, (val) => val >= 0)

  const xLeftLine = createAxis(Math.min(...left.x), Math.max(...left.x) - DELTA_X, DELTA_X)
  const yLeftLine = Array.from({ length: xLeftLine.length }, () => Math.min(...left.y))

  const horzOffset = 1 * halfTriangle
  const minRight = Math.min(...right.x)
  const xRightStart = firstValueGreaterThan(xSimAxis, minRight)
  const xRightLine = createAxis(
    xRightStart ?? minRight,
    Math.max(...right.x) + horzOffset,
    DELTA_X,
  )
  const yRightLine = Array.from({ length: xRightLine.length }, () => Math.min(...right.y))

  const xTopLine = Array.from(xSimAxis).filter(
    (val) => val > Math.min(...left.x) && val < Math.max(...right.x),
  )
  const yTopLine = Array.from({ length: xTopLine.length }, () => Math.max(...left.y))

  const xSurfTriangle = [...xLeftLine, ...left.x, ...xTopLine, ...right.x, ...xRightLine]
  const ySurfTriangle = [...yLeftLine, ...left.y, ...yTopLine, ...right.y, ...yRightLine].map(
    (val) => val + yShift,
  )

  let xSurf = [...xSurfTriangle]
  let repeats = 1
  for (let i = 2; i <= numTriangles; i += 1) {
    const xOffset = firstValueGreaterThan(xSimAxis, xSurf[xSurf.length - 1])
    if (xOffset == null) {
      break
    }
    const shifted = xSurfTriangle.map((val) => val + xOffset)
    xSurf = xSurf.concat(shifted)
    repeats += 1
  }

  const ySurf = repeatArray(ySurfTriangle, repeats)
  const xSurfWithEndpoints = addSurfaceEndpoints(Float64Array.from(xSurf))
  const ySurfWithEndpoints = addSurfaceY(Float64Array.from(ySurf))
  const ySurfImg = computeMaxPerAxis(xSurfWithEndpoints, ySurfWithEndpoints)

  return {
    xSurface: xSurfWithEndpoints,
    ySurface: ySurfWithEndpoints,
    ySurfaceImaging: ySurfImg,
  }
}

function randomSurface(): SurfaceData {
  const numSquares = 5
  const yShift = 0.05
  const totalLen = xSimAxis[xSimAxis.length - 1] - xSimAxis[0]
  const squareLen = totalLen / (2 * numSquares)
  const numPts = pointsForDistance(squareLen)
  const heights = [1, 2, 0.5, 1.25, 0.25, 0.75, 1, 0.5, 1.5, 0.125]
  const pattern: number[] = []

  for (let i = 0; i < numSquares; i += 1) {
    const val = heights[i] * squareLen + yShift
    for (let j = 0; j < numPts - 1; j += 1) {
      pattern.push(val)
    }
  }

  const halfTriangle = 0.5 * squareLen
  const xTriangle = createAxis(-halfTriangle, halfTriangle, DELTA_X)
  const triangleY = Array.from(xTriangle, (x) => -Math.abs(x) + Math.max(...xTriangle) + yShift + heights[5])
  pattern.push(...triangleY)

  for (let i = numSquares + 1; i < numSquares * 2; i += 1) {
    const val = heights[i] * squareLen + yShift
    for (let j = 0; j < numPts - 1; j += 1) {
      pattern.push(val)
    }
  }

  return surfaceFromPattern(pattern, undefined)
}

function surfaceFromPattern(pattern: number[], imagingOverride?: number[]): SurfaceData {
  const adjusted = adjustLength(pattern, xSimAxis.length)
  const imaging = imagingOverride ? adjustLength(imagingOverride, xSimAxis.length) : adjusted
  const ySurface = Float64Array.from(adjusted)
  return {
    xSurface: addSurfaceEndpoints(xSimAxis),
    ySurface: addSurfaceY(ySurface),
    ySurfaceImaging: Float64Array.from(imaging),
  }
}

function pointsForDistance(distance: number): number {
  const target = xSimAxis[0] + distance
  let bestIndex = 1
  let bestErr = Infinity
  for (let i = 0; i < xSimAxis.length; i += 1) {
    const err = Math.abs(xSimAxis[i] - target)
    if (err < bestErr) {
      bestErr = err
      bestIndex = i + 1
    }
  }
  return Math.max(2, bestIndex)
}

function repeatPattern(pattern: number[], count: number): number[] {
  const arr: number[] = []
  for (let i = 0; i < count; i += 1) {
    arr.push(...pattern)
  }
  return arr
}

function adjustLength(values: number[], target: number): number[] {
  if (values.length === target) {
    return values
  }
  if (values.length < target) {
    return [...values, ...Array(target - values.length).fill(0)]
  }
  const halfTarget = Math.round(0.5 * target)
  const halfValues = Math.round(0.5 * values.length)
  const start = Math.max(0, halfValues - halfTarget)
  return values.slice(start, start + target)
}

function addSurfaceEndpoints(xSurf: Float64Array): Float64Array {
  const arr = new Float64Array(xSurf.length + 2)
  arr[0] = xSurf[0]
  arr.set(xSurf, 1)
  arr[arr.length - 1] = xSurf[xSurf.length - 1]
  return arr
}

function addSurfaceY(ySurf: Float64Array): Float64Array {
  const arr = new Float64Array(ySurf.length + 2)
  arr[0] = 0
  arr.set(ySurf, 1)
  arr[arr.length - 1] = 0
  return arr
}

function computeMaxPerAxis(xSurf: Float64Array, ySurf: Float64Array): Float64Array {
  const roundDigits = Math.abs(Math.log10(DELTA_X)) + 1
  const xSurfRounded = Array.from(xSurf, (val) => roundTo(val, roundDigits))
  const ySurfaceImg = new Float64Array(xSimAxis.length)
  for (let i = 0; i < xSimAxis.length; i += 1) {
    const xValue = roundTo(xSimAxis[i], roundDigits)
    let maxVal = -Infinity
    let found = false
    for (let j = 0; j < xSurfRounded.length; j += 1) {
      if (xSurfRounded[j] === xValue) {
        const yVal = ySurf[j]
        if (yVal > maxVal) {
          maxVal = yVal
        }
        found = true
      }
    }
    ySurfaceImg[i] = found ? maxVal : 0
  }
  return ySurfaceImg
}

function filterByMask(
  xValues: number[],
  yValues: number[],
  predicate: (value: number) => boolean,
): { x: number[]; y: number[] } {
  const x: number[] = []
  const y: number[] = []
  for (let i = 0; i < yValues.length; i += 1) {
    if (!predicate(yValues[i])) continue
    x.push(xValues[i])
    y.push(yValues[i])
  }
  return { x, y }
}

function firstValueGreaterThan(values: Float64Array, target: number): number | null {
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] > target) return values[i]
  }
  return null
}

function repeatArray(values: number[], count: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i += 1) {
    out.push(...values)
  }
  return out
}

function roundTo(value: number, digits: number): number {
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}
export interface SimulationResult {
  yCenter: Float64Array
  ySurfaceImage: Float64Array
}

export function computeSurfaceResponse(
  yTip: Float64Array,
  ySurfImage: Float64Array,
  centerY: number,
  yTipDist: number,
): SimulationResult {
  const lenTip = yTip.length
  const paddingLeft = Math.ceil(0.5 * lenTip)
  const paddingRight = lenTip - paddingLeft - 1
  const padded = new Float64Array(paddingLeft + ySurfImage.length + paddingRight)
  let offset = 0
  for (let i = 0; i < paddingLeft; i += 1) {
    padded[offset++] = 0
  }
  padded.set(ySurfImage, offset)
  offset += ySurfImage.length
  for (let i = 0; i < paddingRight; i += 1) {
    padded[offset++] = 0
  }

  const rowCount = padded.length - lenTip + 1
  const yCenter = new Float64Array(rowCount)
  const ySurfaceImage = new Float64Array(rowCount)

  for (let row = 0; row < rowCount; row += 1) {
    let minDist = Number.POSITIVE_INFINITY
    for (let col = 0; col < lenTip; col += 1) {
      const diff = yTip[col] - padded[row + col]
      if (diff < minDist) {
        minDist = diff
      }
    }
    const center = centerY - minDist
    yCenter[row] = center
    ySurfaceImage[row] = center - yTipDist
  }

  return { yCenter, ySurfaceImage }
}

export function micronsToNormalized(distance: number): number {
  return distance / (MAX_TIP_RADIUS * MAX_TIP_RADIUS_UNITS)
}

export function normalizedStepToIndex(step: number): number {
  return Math.max(1, Math.round(step / DELTA_X))
}

export const SCALE_BAR_UNITLESS = SCALE_BAR_MICRONS / (MAX_TIP_RADIUS * MAX_TIP_RADIUS_UNITS)

export function initialSimulationCenter(tipRadius: number, surfaceMax: number): {
  x: number
  y: number
} {
  const tipDistSurf = 0.5
  return {
    x: xSimAxis[0],
    y: surfaceMax + tipDistSurf + tipRadius,
  }
}
