import type { TaskContract } from '../types.js';
export declare function buildInitialDelegationPrompt(params: {
    objective: string;
    contract: TaskContract;
    resetInstruction?: string;
    existingChangedFiles?: string[];
}): string;
export declare function buildResumeSteerPrompt(instruction: string): string;
