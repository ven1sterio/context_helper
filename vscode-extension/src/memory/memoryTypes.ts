export interface Decision {
    id: string;
    title: string;
    rationale: string;
    date: string;
    relatedFiles: string[];
}

export interface Knowledge {
    id: string;
    topic: string;
    content: string;
    confidence: 'low' | 'medium' | 'high';
    source: string;
    createdAt: string;
}

export type ErrorStatus = 'open' | 'resolved' | 'wontfix';

export interface ErrorRecord {
    id: string;
    message: string;
    file?: string;
    cause?: string;
    solution?: string;
    status: ErrorStatus;
    verified: boolean;
    createdAt: string;
    resolvedAt?: string;
}

export interface Convention {
    id: string;
    category: string;
    rule: string;
    examples: string[];
}

export interface CompletedTask {
    id: string;
    title: string;
    missionId?: string;
    files: string[];
    evidence: string;
    completedAt: string;
}
