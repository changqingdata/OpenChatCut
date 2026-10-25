// Pre-compile validation.
//
// Runs before anything touches a project, so an agent's malformed storyboard is
// rejected cheaply instead of producing a broken timeline that has to be undone.
// Errors block compilation; warnings do not.

import type { CompileWarning, Storyboard } from './types.ts';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: CompileWarning[];
}

const SUPPORTED_VISUALS = new Set(['mg', 'mg-code', 'text', 'solid', 'asset']);

export function validateStoryboard(storyboard: Storyboard): ValidationResult {
  const errors: string[] = [];
  const warnings: CompileWarning[] = [];
  const { meta, rhythm, beats, shots } = storyboard;

  if (storyboard.version !== 1) errors.push(`storyboard.version must be 1, got ${String(storyboard.version)}`);
  if (!meta?.runId?.trim()) errors.push('meta.runId is required');
  if (!meta?.title?.trim()) errors.push('meta.title is required');
  if (!(meta?.width > 0)) errors.push('meta.width must be positive');
  if (!(meta?.height > 0)) errors.push('meta.height must be positive');
  if (!(meta?.fps > 0)) errors.push('meta.fps must be positive');

  if (!Array.isArray(shots) || shots.length === 0) {
    errors.push('shots must contain at least one shot');
    return { ok: false, errors, warnings };
  }

  const beatIds = new Set((beats ?? []).map((beat) => beat.id));
  if (beatIds.size !== (beats ?? []).length) errors.push('beat ids must be unique');

  const seen = new Set<string>();
  let previousEnd = 0;

  for (const shot of shots) {
    const label = shot.id || '(missing id)';

    if (!shot.id?.trim()) errors.push('every shot needs a non-empty id');
    else if (seen.has(shot.id)) errors.push(`duplicate shot id: ${shot.id}`);
    seen.add(shot.id);

    if (!Number.isFinite(shot.startFrame) || !Number.isFinite(shot.endFrame)) {
      errors.push(`${label}: startFrame and endFrame must be numbers`);
      continue;
    }
    if (shot.startFrame < 0) errors.push(`${label}: startFrame must be >= 0`);
    if (shot.endFrame <= shot.startFrame) {
      errors.push(`${label}: endFrame (${shot.endFrame}) must be greater than startFrame (${shot.startFrame})`);
    }
    if (shot.startFrame < previousEnd) {
      warnings.push({
        shotId: shot.id,
        code: 'overlap',
        message: `${label} starts at frame ${shot.startFrame}, before the previous shot ends at ${previousEnd}`,
      });
    }
    previousEnd = Math.max(previousEnd, shot.endFrame);

    // beatId only has to resolve when the storyboard actually declares beats.
    if (beatIds.size > 0) {
      if (!shot.beatId?.trim()) errors.push(`${label}: beatId is required when beats are declared`);
      else if (!beatIds.has(shot.beatId)) {
        errors.push(`${label}: beatId "${shot.beatId}" does not match any beat`);
      }
    }

    if (!shot.intent?.trim()) errors.push(`${label}: intent is required — it drives QC`);

    const visual = shot.visual;
    if (!visual || !SUPPORTED_VISUALS.has(visual.kind)) {
      errors.push(`${label}: unsupported visual kind "${String((visual as { kind?: string } | undefined)?.kind)}"`);
      continue;
    }
    if (visual.kind === 'mg' && !visual.recipe?.trim()) errors.push(`${label}: mg.recipe is required`);
    if (visual.kind === 'mg-code') {
      if (!visual.code?.trim()) errors.push(`${label}: mg-code.code is required`);
      if (!(visual.box?.width > 0) || !(visual.box?.height > 0)) {
        errors.push(`${label}: mg-code.box must have positive width and height`);
      }
    }
    if (visual.kind === 'asset' && !visual.assetId?.trim()) errors.push(`${label}: asset.assetId is required`);
    if (visual.kind === 'text' && !visual.text?.trim()) errors.push(`${label}: text.text is required`);

    const layout = 'layout' in visual ? visual.layout : undefined;
    if (layout && !(layout.widthRatio > 0 && layout.widthRatio <= 1)) {
      errors.push(`${label}: layout.widthRatio must be in (0, 1]`);
    }

    if (rhythm?.maxShotSec > 0) {
      const seconds = (shot.endFrame - shot.startFrame) / meta.fps;
      if (seconds > rhythm.maxShotSec) {
        warnings.push({
          shotId: shot.id,
          code: 'shot-too-long',
          message: `${label} runs ${seconds.toFixed(1)}s, above the ${rhythm.maxShotSec}s ceiling`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
