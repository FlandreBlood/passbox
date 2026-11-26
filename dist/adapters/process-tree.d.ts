import type { ProcessIdentityRecord } from '../types.js';
interface ProcessRow {
    pid: number;
    parent: number;
    born: string;
}
export declare function queryProcessTable(): ProcessRow[] | null;
export declare function captureProcessIdentity(pid: number | null | undefined): ProcessIdentityRecord | null;
export declare function isProcessIdentityAlive(identity: ProcessIdentityRecord | null | undefined, verifyBorn?: boolean): boolean;
export declare function terminateProcessTree(pid: number | null | undefined): Promise<void>;
export {};
