// The app-side door to the compiler.
//
// `apply_storyboard` is deliberately one tool doing the whole distance from shot
// list to timeline: density, plates, graphics, captions, and the storyboard
// itself, dispatched as a single batch so one undo takes it all back. Splitting
// it into "add clip / set captions / store board" would hand the ordering problem
// to the model, and the ordering is the pipeline's job.
import type { AgentContext } from '../context';
import type { CaptionTemplate } from '../../captions/types';
import type { Storyboard } from '../../pipeline/types';
import { validateStoryboard } from '../../pipeline/validate';
import { runQc } from '../../pipeline/qc';
import { planApplyStoryboard } from '../../pipeline/storyboard-apply';
import { schemasFromTemplates } from '../../pipeline/templates';

type Args = Record<string, unknown>;

const asArgs = (args: Args): Args => args ?? {};

export async function execStoryboardTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  const input = asArgs(args);

  if (name === 'get_storyboard') {
    const doc = ctx.getDoc();
    const storyboard = doc.storyboard;
    if (!storyboard) {
      return { ok: true, storyboard: null, appliedHash: null, matchesTimeline: null };
    }
    return {
      ok: true,
      storyboard,
      appliedHash: doc.storyboardAppliedHash ?? null,
      // A board that no longer matches what was applied means someone edited the
      // timeline by hand; re-applying is the way back, and this is the signal.
      matchesTimeline: doc.storyboardAppliedHash
        ? doc.storyboardAppliedHash === planApplyStoryboard({
          doc, storyboard, templates: ctx.templates,
        }).hash
        : false,
      shots: storyboard.shots.length,
    };
  }

  if (name !== 'apply_storyboard') return { error: `unknown storyboard tool ${name}` };

  const storyboard = input.storyboard as Storyboard | undefined;
  if (!storyboard || typeof storyboard !== 'object') {
    return { error: 'apply_storyboard needs a `storyboard` object' };
  }

  const doc = ctx.getDoc();
  const checked = validateStoryboard(storyboard);
  if (!checked.ok) {
    return { error: 'storyboard failed validation', errors: checked.errors };
  }

  const captions = input.captions === false
    ? false
    : {
      ...(typeof input.captionTemplate === 'string' ? { template: input.captionTemplate as CaptionTemplate } : {}),
      ...(input.captionPacing === 'word' ? { pacing: 'word' as const } : {}),
    };

  let plan;
  try {
    plan = planApplyStoryboard({
      doc,
      storyboard,
      templates: ctx.templates,
      replace: input.replace !== false,
      captions,
      ...(typeof input.timelineId === 'string' ? { timelineId: input.timelineId } : {}),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  // One dispatch: one history entry, one undo.
  ctx.commands.batch(plan.actions, 'Apply storyboard');

  // The rules run on the board, not on the compiled doc, so the report names the
  // shot the author has to change rather than a clip id they cannot see.
  const qc = runQc(storyboard, { schemas: schemasFromTemplates(ctx.templates), captions: captions !== false });

  return {
    ok: true,
    hash: plan.hash,
    items: plan.items,
    seconds: plan.seconds,
    captions: plan.captions,
    tracks: plan.tracks,
    warnings: plan.warnings,
    findings: qc.findings,
  };
}
