// <VectorLayer> — draws each feature's vector as an arrow at its anchor point
// (the point itself, a line's midpoint, or a region's centroid). Direction
// comes from the vector, size from its magnitude; color and opacity use the
// same encodings as scalars (color by MAGNITUDE_FIELD for "by length").

import { computed, defineComponent, onBeforeUnmount, watch, type PropType } from 'vue'
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { bindInteraction, setVisibility, useMap, type HoverInfo } from './mapContext'
import { ensureArrowImage } from './images'
import { anchorPoint } from '../../lib/geometry'
import { DIRECTION_FIELD, MAGNITUDE_FIELD, colorExpression, opacityExpression, sizeExpression, vectorOf, type VectorStyle } from '../../lib/style'
import type { LayerData, LayerFeature } from '../../lib/schema'

export default defineComponent({
  name: 'VectorLayer',
  props: {
    layer: { type: Object as PropType<LayerData>, required: true },
    styleSpec: { type: Object as PropType<VectorStyle>, required: true },
    visible: { type: Boolean, default: true },
    /** Let arrows overlap instead of thinning them out at low zoom. */
    allowOverlap: { type: Boolean, default: false },
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
    const arrows = `${id}-arrows`

    const arrowFeatures = computed<LayerFeature[]>(() =>
      props.layer.features.flatMap((f) => {
        const at = anchorPoint(f.geometry)
        const vec = vectorOf(f.properties, props.styleSpec.components)
        if (!at || !vec) return []
        return [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: at },
            properties: { ...f.properties, [MAGNITUDE_FIELD]: vec.magnitude, [DIRECTION_FIELD]: vec.direction },
          },
        ]
      }),
    )
    const data = () => ({ type: 'FeatureCollection' as const, features: arrowFeatures.value })

    map.addSource(src, { type: 'geojson', data: data(), promoteId: props.layer.idField })
    map.addLayer(
      {
        id: arrows,
        type: 'symbol',
        source: src,
        layout: {
          'icon-image': ensureArrowImage(map),
          'icon-rotate': ['get', DIRECTION_FIELD],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': props.allowOverlap,
          'icon-padding': 0,
        },
        paint: {},
      },
      ctx.slot('vector'),
    )

    function apply() {
      const s = props.styleSpec
      const feats = arrowFeatures.value
      map.setLayoutProperty(arrows, 'icon-size', sizeExpression(s, feats) as never)
      map.setLayoutProperty(arrows, 'icon-allow-overlap', props.allowOverlap)
      map.setPaintProperty(arrows, 'icon-color', colorExpression(s.color, feats) as never)
      map.setPaintProperty(arrows, 'icon-opacity', opacityExpression(s.opacity, feats) as never)
      map.setPaintProperty(arrows, 'icon-halo-color', 'rgba(255,255,255,0.85)')
      map.setPaintProperty(arrows, 'icon-halo-width', ['case', ['boolean', ['feature-state', 'hover'], false], 3, 1] as never)
    }
    apply()
    setVisibility(map, [arrows], props.visible)

    const unbind = bindInteraction(map, ctx, arrows, src, (h) => emit('hover', h), (fid) => emit('select', fid))

    watch(arrowFeatures, () => {
      ;(map.getSource(src) as GeoJSONSource).setData(data())
      apply()
    })
    watch(() => props.styleSpec, apply, { deep: true })
    watch(() => props.allowOverlap, apply)
    watch(
      () => props.visible,
      (v) => setVisibility(map, [arrows], v),
    )

    onBeforeUnmount(() => {
      unbind()
      if (!map.getStyle()) return
      if (map.getLayer(arrows)) map.removeLayer(arrows)
      if (map.getSource(src)) map.removeSource(src)
    })

    return () => null
  },
})
