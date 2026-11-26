import type { ChangedFileEntry, DiffTotals, GuardSignals } from '../types.js';
export declare function normalizeRepoRelPath(p: string): string;
export declare function splitUnifiedDiffByFile(fullPatch: string): Map<string, string>;
export declare function analyzeGuardSignals(perFilePatches: Map<string, string>): GuardSignals;
export declare function computeUnexpectedFiles(changedPaths: string[], expectedFiles?: string[]): string[];
export interface ComputedTreeDiff {
    files: ChangedFileEntry[];
    totals: DiffTotals;
    fullPatch: string;
    previewEligiblePatch: string;
    perFilePatches: Map<string, string>;
    guardSignals: GuardSignals;
}
export declare function computeTreeDiff(repoRoot: string, fromTreeOid: string, toTreeOid: string): ComputedTreeDiff;
