import React, { useState, useMemo } from 'react'
import {
  Canvas,
  Circle,
  Paint,
  Path,
  Vertices,
} from '@shopify/react-native-skia'
import { View, useWindowDimensions } from 'react-native'
import {
  SharedValue,
  interpolateColor,
  runOnJS,
  useAnimatedReaction,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler'
import cdt2d from 'cdt2d'

const colorStream = [
  'red',
  'green',
  'blue',
  'orange',
  'yellow',
  'red',
  'green',
  'blue',
  'orange',
  'yellow',
  'red',
  'green',
  'blue',
  'orange',
  'yellow',
].reverse()

const animationConfigForward = { duration: 400 }
const animationConfigBack = { duration: 200 }

const HueBackground = ({
  colors,
  target,
  derivedVertices,
}: {
  colors: SharedValue<string[]>
  target: {
    x: SharedValue<number>
    y: SharedValue<number>
    color: SharedValue<string>
  }[]
  derivedVertices: SharedValue<
    {
      x: number
      y: number
    }[]
  >
}) => {
  const triangles = useMemo(
    () => cdt2d(target.map(({ x, y }) => [x.value, y.value])),
    [],
  )
  const indices = triangles.flat()

  const path = useDerivedValue(() => {
    const f = ({ x, y }: Vertex) => [x, y].join(',')

    return triangles
      .map(([a, b, c]: [number, number, number]) => {
        const v1 = derivedVertices.value[a]
        const v2 = derivedVertices.value[b]
        const v3 = derivedVertices.value[c]
        return `M${f(v1)} L${f(v2)} L${f(v3)} Z`
      })
      .join('')
  })

  return (
    <>
      <Vertices
        vertices={derivedVertices}
        indices={indices}
        style="stroke"
        color="black"
        strokeWidth={2}
        colors={colors}
      />
      <Path path={path} strokeWidth={2} color="black" style="stroke" />
    </>
  )
}

type Vertex = { x: number; y: number }
type ColoredVertex = Vertex & { color: string }

const createGrid = ({
  rows,
  cols,
  pages,
  width,
  height,
}: {
  rows: number
  cols: number
  pages: number
  width: number
  height: number
}) => {
  const hSize = width / cols
  const vSize = height / rows
  const totalWidth = width * pages
  const totalColumns = cols + Math.ceil(totalWidth / hSize)
  const totalRows = rows + 1

  const grid = Array.from({ length: totalColumns }, (_, col) =>
    Array.from(
      { length: totalRows },
      (_, row) =>
        ({
          x: col * hSize,
          y: row * vSize,
        } as Vertex),
    ),
  ).flat()

  return { grid, hSize, vSize, totalColumns }
}

const createStreamedGrid = ({
  rows,
  cols,
  pages,
  width,
  height,
  colorStream,
}: {
  rows: number
  cols: number
  pages: number
  width: number
  height: number
  colorStream: string[]
}) => {
  const {
    grid: baseGrid,
    hSize,
    totalColumns,
  } = createGrid({
    rows,
    cols,
    pages,
    width,
    height,
  })

  return baseGrid.map(({ x, y }) =>
    Array.from(
      { length: totalColumns + 1 },
      (_, i) =>
        ({
          x: x + hSize * (i - totalColumns),
          y: y,
          color: colorStream[i],
        } as ColoredVertex),
    ),
  )
}

const getCurrentGrid = ({
  gridStreams,
  current,
}: {
  gridStreams: ColoredVertex[][]
  current: number
}) => {
  'worklet'
  return gridStreams.map((stream, index) => stream[stream.length - 1 + current])
}

const getTargetGridAtStep = ({
  gridStreams,
  current,
  step,
}: {
  gridStreams: ColoredVertex[][]
  current: number
  step: number
}) => {
  'worklet'
  const updatedCurrent = current + step

  const nextGrid = gridStreams.map((stream, index) => {
    const newPositionIndex = Math.max(
      0,
      Math.min(stream.length - 1, stream.length - 1 + updatedCurrent),
    )
    return stream[newPositionIndex]
  })

  return nextGrid
}

export const Hue: React.FC = () => {
  const { width, height } = useWindowDimensions()

  const cols = 1,
    rows = 1,
    pages = 4

  const gridStreams = useMemo(
    () =>
      createStreamedGrid({
        rows,
        cols,
        pages,
        width,
        height,
        colorStream,
      }),
    [],
  )

  const step = useSharedValue(0)

  const currentGrid = useDerivedValue(() =>
    getCurrentGrid({ gridStreams, current: step.value }),
  )
  const targetGrid = useDerivedValue(() =>
    getTargetGridAtStep({
      gridStreams,
      current: step.value,
      step: -1,
    }),
  )

  const offset = useSharedValue(0)
  const isPanningRunning = useSharedValue(true)
  const isMouseDownForPanning = useSharedValue(false)
  const direction = useSharedValue(0)
  const xInternal = currentGrid.value.map(c => useSharedValue(c.x))
  const yInternal = currentGrid.value.map(c => useSharedValue(c.y))
  const colorInternal = currentGrid.value.map(c => useSharedValue(c.color))
  const animationComleted = useSharedValue(0)

  const target = currentGrid.value.map((currentVertex, vertexIndex) => {
    return {
      x: useSharedValue(currentVertex.x),
      y: useSharedValue(currentVertex.y),
      color: useSharedValue(currentVertex.color),
    }
  })

  useAnimatedReaction(
    () => offset.value,
    () => {
      target.forEach((vertex, i) => {
        vertex.x.value =
          currentGrid.value[i].x -
          (targetGrid.value[i].x - currentGrid.value[i].x) * offset.value
        vertex.y.value = currentGrid.value[i].y
        vertex.color.value = interpolateColor(
          Math.abs(offset.value),
          [0, 1],
          [currentGrid.value[i].color, targetGrid.value[i].color],
        )
      })
    },
  )

  useAnimatedReaction(
    () => isMouseDownForPanning.value,
    (current, previous) => {
      if (current === false && previous === true) {
        if (isPanningRunning.value === true && direction.value !== 0) {
          if (Math.abs(offset.value) > 0.5) {
            step.value = step.value + direction.value
          }

          offset.value = 0
          isPanningRunning.value = false
        }
      }
    },
  )

  const pan = Gesture.Pan()
    .onStart(() => {
      isPanningRunning.value = true
      isMouseDownForPanning.value = true
      offset.value = 0
      direction.value = 0
    })
    .onUpdate(event => {
      if (direction.value === 0) {
        direction.value = event.velocityX > 0 ? 1 : -1
      }

      if (isPanningRunning.value == false) {
        return
      } else {
        offset.value = (event.translationX / width) * 1
      }
    })
    .onEnd(() => {
      isMouseDownForPanning.value = false
    })

  useAnimatedReaction(
    () => target[0].x.value,
    () => {
      if (isPanningRunning.value === true) {
        if (isMouseDownForPanning.value === true) {
          xInternal.forEach((x, i) => (x.value = target[i].x.value))
        } else {
          xInternal.forEach((x, i) => {
            if (i === 0) {
              //NOTE: Callback to keep track of animation completion
              animationComleted.value = 0
              x.value = withTiming(
                currentGrid.value[i].x,
                animationConfigBack,
                isFinished => {
                  if (isFinished) animationComleted.value = 1
                },
              )
            } else {
              x.value = withTiming(currentGrid.value[i].x, animationConfigBack)
            }
          })
        }
      } else {
        xInternal.forEach((x, i) => {
          if (i === 0) {
            //NOTE: Callback to keep track of animation completion
            animationComleted.value = 0
            x.value = withTiming(
              target[i].x.value,
              animationConfigForward,
              isFinished => {
                if (isFinished) animationComleted.value = 1
              },
            )
          } else {
            x.value = withTiming(target[i].x.value, animationConfigForward)
          }
        })
      }
    },
  )

  useAnimatedReaction(
    () => target[0].y.value,
    () => {
      if (isPanningRunning.value === true) {
        if (isMouseDownForPanning.value === true) {
          yInternal.forEach((y, i) => (y.value = target[i].y.value))
        } else {
          yInternal.forEach(
            (y, i) =>
              (y.value = withTiming(
                currentGrid.value[i].y,
                animationConfigBack,
              )),
          )
        }
      } else {
        yInternal.forEach(
          (y, i) =>
            (y.value = withTiming(target[i].y.value, animationConfigForward)),
        )
      }
    },
  )

  useAnimatedReaction(
    () => target[0].color.value,
    () => {
      colorInternal.forEach(
        (color, i) =>
          (color.value = interpolateColor(
            Math.abs(offset.value),
            [0, 1],
            [currentGrid.value[i].color, targetGrid.value[i].color],
          )),
      )
    },
  )

  useAnimatedReaction(
    () => animationComleted.value,
    (current, previous) => {
      if (current === 1 && previous === 0) {
        animationComleted.value = 0
      }
    },
  )

  const derivedVertices = useDerivedValue(() =>
    xInternal.map((x, i) => ({
      x: x.value,
      y: yInternal[i].value,
    })),
  )

  const colors = useDerivedValue(() => colorInternal.map(color => color.value))

  return (
    <View style={{ flex: 1 }}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <GestureDetector gesture={pan}>
          <Canvas style={{ flex: 1, backgroundColor: 'white' }}>
            <HueBackground
              colors={colors}
              target={target}
              derivedVertices={derivedVertices}
            />
            {xInternal.map((x, i) => (
              <Circle
                key={i}
                cx={x}
                cy={yInternal[i]}
                r={20}
                color={colorInternal[i]}>
                <Paint color="black" style="stroke" strokeWidth={1} />
              </Circle>
            ))}
          </Canvas>
        </GestureDetector>
      </GestureHandlerRootView>
    </View>
  )
}
