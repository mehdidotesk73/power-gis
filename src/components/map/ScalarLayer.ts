// <ScalarLayer> — draws a LayerData with a ScalarStyle.
//   region   → fill (color + opacity) + pattern overlays + outline
//   polyline → line (color + opacity, width = style.size)
//   point    → circle (color + opacity, radius = style.size)
// Emits `hover` (HoverInfo | null) and `select` (feature id) for panels.

import { HIGHLIGHT, PATTERN_INK, SELECTED } from '../../lib/mapTheme'
import { defineComponent, onBeforeUnmount, watch, type PropType } from 'vue'
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { bindInteraction, setVisibility, useMap, type HoverInfo } from './mapContext'
import { ensurePatternImage } from './images'
import { colorExpression, opacityExpression, patternGroups, type ScalarStyle } from '../../lib/style'
import type { LayerData } from '../../lib/schema'

export default defineComponent({
  name: 'ScalarLayer',
  props: {
    layer: { type: Object as PropType<LayerData>, required: true },
    styleSpec: { type: Object as PropType<ScalarStyle>, required: true },
    visible: { type: Boolean, default: true },
    /** Feature ids to outline prominently (e.g. one utility's territory). */
    highlightIds: { type: Array as PropType<string[]>, default: () => [] },
    selectedId: { type: String as PropType<string | null>, default: null },
  },
  emits: {
    hover: (_h: HoverInfo | null) => true,
    select: (_id: string) => true,
  },
  setup(props, { emit }) {
    const ctx = useMap()
    const map = ctx.map.value as MlMap
    const id = props.layer.id
    const src = `${id}-src`
    const main = `${id}-main`
    const outline = `${id}-outline`
    const highlight = `${id}-highlight`
    const geom = props.layer.geometry
    const before = ctx.slot(geom)
    let patternLayers: string[] = []
    let prevSelected: string | null = null

    const data = () => ({ type: 'FeatureCollection' as const, features: props.layer.features })

    map.addSource(src, { type: 'geojson', data: data(), promoteId: props.layer.idField })

    const hoverOrSelected = ['any', ['boolean', ['feature-state', 'hover'], false], ['boolean', ['feature-state', 'selected'], false]]
    if (geom === 'region') {
      map.addLayer({ id: main, type: 'fill', source: src, paint: {} }, before)
      map.addLayer({ id: outline, type: 'line', source: src, paint: {} }, before)
    } else if (geom === 'polyline') {
      map.addLayer({ id: main, type: 'line', source: src, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {} }, before)
    } else {
      map.addLayer({ id: main, type: 'circle', source: src, paint: {} }, before)
    }
    map.addLayer(
      {
        id: highlight,
        type: 'line',
        source: src,
        filter: ['in', ['get', props.layer.idField], ['literal', []]],
        paint: { 'line-color': HIGHLIGHT, 'line-width': 2.5 },
      },
      before,
    )

    function applyPaint() {
      const s = props.styleSpec
      const feats = props.layer.features
      const color = colorExpression(s.color, feats)
      const opacity = opacityExpression(s.opacity, feats)
      const set = (layer: string, prop: string, value: unknown) => map.setPaintProperty(layer, prop as never, value as never)
      const ol = s.outline ?? { color: '#ffffff', width: 0.4, opacity: 0.6 }
      if (geom === 'region') {
        set(main, 'fill-color', color)
        set(main, 'fill-opacity', opacity)
        set(outline, 'line-color', ['case', hoverOrSelected, SELECTED, ol.color])
        set(outline, 'line-width', ['case', hoverOrSelected, 2, ol.width])
        set(outline, 'line-opacity', ['case', hoverOrSelected, 1, ol.opacity ?? 1])
      } else if (geom === 'polyline') {
        set(main, 'line-color', color)
        set(main, 'line-opacity', opacity)
        set(main, 'line-width', ['case', hoverOrSelected, (s.size ?? 2) + 2, s.size ?? 2])
      } else {
        set(main, 'circle-color', color)
        set(main, 'circle-opacity', opacity)
        set(main, 'circle-radius', ['case', hoverOrSelected, (s.size ?? 5) + 2, s.size ?? 5])
        set(main, 'circle-stroke-color', ol.color)
        set(main, 'circle-stroke-width', ol.width)
      }
    }

    function syncPatterns() {
      for (const l of patternLayers) if (map.getLayer(l)) map.removeLayer(l)
      patternLayers = []
      if (geom !== 'region') return // patterns are a region encoding
      const p = props.styleSpec.pattern
      if (p.kind === 'none') return
      const color = p.color ?? PATTERN_INK
      patternGroups(p).forEach((g, i) => {
        const lid = `${id}-pattern-${i}`
        map.addLayer(
          {
            id: lid,
            type: 'fill',
            source: src,
            ...(g.filter ? { filter: g.filter as never } : {}),
            layout: { visibility: props.visible ? 'visible' : 'none' },
            paint: { 'fill-pattern': ensurePatternImage(map, g.pattern, color), 'fill-opacity': p.opacity ?? 0.8 },
          },
          outline,
        )
        patternLayers.push(lid)
      })
    }

    const allLayers = () => [main, outline, highlight, ...patternLayers].filter((l) => map.getLayer(l))

    applyPaint()
    syncPatterns()
    setVisibility(map, allLayers(), props.visible)

    const unbind = bindInteraction(map, ctx, main, src, (h) => emit('hover', h), (fid) => emit('select', fid))
    ctx.stacks.set(id, { kind: geom, layerIds: () => [main, ...patternLayers, outline, highlight].filter((l) => map.getLayer(l)) })
    ctx.restackSoon()

    watch(
      () => props.layer,
      () => {
        ;(map.getSource(src) as GeoJSONSource).setData(data())
        applyPaint()
      },
    )
    watch(
      () => props.styleSpec,
      () => {
        applyPaint()
        syncPatterns()
        ctx.restackSoon()
      },
      { deep: true },
    )
    watch(
      () => props.visible,
      (v) => setVisibility(map, allLayers(), v),
    )
    watch(
      () => props.highlightIds,
      (ids) => map.setFilter(highlight, ['in', ['get', props.layer.idField], ['literal', ids]]),
      { immediate: true },
    )
    watch(
      () => props.selectedId,
      (sel) => {
        if (prevSelected !== null) map.setFeatureState({ source: src, id: prevSelected }, { selected: false })
        if (sel !== null) map.setFeatureState({ source: src, id: sel }, { selected: true })
        prevSelected = sel
      },
      { immediate: true },
    )

    onBeforeUnmount(() => {
      unbind()
      ctx.stacks.delete(id)
      if (!map.getStyle()) return
      for (const l of allLayers()) map.removeLayer(l)
      if (map.getSource(src)) map.removeSource(src)
    })

    return () => null
  },
})
