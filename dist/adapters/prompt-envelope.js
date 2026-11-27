export function buildInitialDelegationPrompt(params) {
    const { objective, contract, resetInstruction, existingChangedFiles } = params;
    const sections = [];
    sections.push(`# Task Objective\n${objective.trim()}`);
    const contractLines = [];
    if (contract.expected_files && contract.expected_files.length > 0) {
        contractLines.push(`Expected files (non-restrictive orientation hints; read or edit other files if evidence warrants):\n` +
            contract.expected_files.map((f) => `- ${f}`).join('\n'));
    }
    if (contract.invariants && contract.invariants.length > 0) {
        contractLines.push(`Upstream invariants (treat as hypotheses grounded in cited locations; if contradicted by actual code, report in counter_evidence):\n` +
            contract.invariants
                .map((inv) => `- ${inv.claim}${inv.evidence ? ` [ref: ${inv.evidence}]` : ''}`)
                .join('\n'));
    }
    if (contract.acceptance && contract.acceptance.length > 0) {
        contractLines.push(`Acceptance criteria:\n` + contract.acceptance.map((a) => `- ${a}`).join('\n'));
    }
    if (contract.verify_commands && contract.verify_commands.length > 0) {
        contractLines.push(`Independent verification commands configured by caller:\n` +
            contract.verify_commands.map((v) => `- ${JSON.stringify(v.argv)}`).join('\n'));
    }
    if (contractLines.length > 0) {
        sections.push(`# Task Contract\n${contractLines.join('\n\n')}`);
    }
    if (existingChangedFiles && existingChangedFiles.length > 0) {
        sections.push(`# Current Workspace Changes Since Task Baseline\n` +
            existingChangedFiles.slice(0, 40).map((f) => `- ${f}`).join('\n'));
    }
    if (resetInstruction && resetInstruction.trim()) {
        sections.push(`# Updated Guidance / Verified Facts\n${resetInstruction.trim()}`);
    }
    sections.push(`# Final Response Protocol\n` +
        `Explore, implement, and verify directly in the repository using your native tools. ` +
        `Return your final response strictly matching the provided JSON Schema ` +
        `(\`status\`: "completed" | "partial" | "blocked", \`blockers\`: [{claim, evidence}], \`counter_evidence\`: [{claim, evidence}]). ` +
        `Keep each \`claim\` concise, non-redundant, and grounded in exact \`file:line\` references in \`evidence\`. ` +
        `Write \`claim\` descriptions in the same language as the Task Objective (e.g., Chinese or English) while keeping JSON keys strictly matching the schema. ` +
        `Do not mask real permission, sandbox, or environment blockers.`);
    return `${sections.join('\n\n')}\n`;
}
export function buildResumeSteerPrompt(instruction) {
    return (`# Follow-up Guidance\n${instruction.trim()}\n\n` +
        `Continue in the current workspace and return your final response strictly matching ` +
        `the JSON Schema (\`status\`, \`blockers\`, \`counter_evidence\`), writing \`claim\` text in the same language as this guidance.\n`);
}
