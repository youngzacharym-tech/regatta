// ============================================================================
// figure-material.ts — the miniatures' paint finishes. Every vertex of
// figures.glb / pieces-core.glb carries a finish code next to its paint
// (`_mat`, written by tools/build_pieces_mk.py): 0 matte cloth and stone,
// .25 satin skin and leather, .5 gloss enamel and eyes, .75 metal, 1 glow
// (crystals, orbs, fel fire — lit from within). One MeshStandardMaterial
// serves a whole figure; patchFigureMaterial teaches it to read the code.
// Geometry without `_mat` (the placeholder cylinders) reads 0: matte.
// ============================================================================

import * as THREE from "three";

/** How much more of the environment the figures reflect than the table
 *  does — polished plate and gilt need something to mirror. */
const FIGURE_ENV = 2.2;

export function patchFigureMaterial(mat: THREE.MeshStandardMaterial): void {
  if (mat.userData.figureFinish) return;
  mat.userData.figureFinish = true;
  mat.envMapIntensity = FIGURE_ENV;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float _mat;\nvarying float vFinish;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvFinish = _mat;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vFinish;")
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\n\troughnessFactor = vFinish < 0.125 ? 0.86 : vFinish < 0.375 ? 0.58" +
          " : vFinish < 0.625 ? 0.30 : vFinish < 0.875 ? 0.32 : 0.45;",
      )
      .replace(
        "#include <metalnessmap_fragment>",
        "#include <metalnessmap_fragment>\n\tmetalnessFactor = vFinish > 0.625 && vFinish < 0.875 ? 1.0 : 0.0;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * step(0.875, vFinish) * 1.6;",
      );
  };
  mat.customProgramCacheKey = () => "mk-figure-finish";
  mat.needsUpdate = true;
}
