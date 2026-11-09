import { Review } from './agentTypes';

export interface ConsensusResult {
    verdict: 'approved' | 'rejected' | 'split';
    votes: { approved: number; rejected: number };
    divergences: string[];
}

/**
 * Combina revisões independentes. Divergência (aprovado + rejeitado) vira
 * 'split' e o diretor decide.
 */
export function computeConsensus(reviews: Review[]): ConsensusResult {
    if (reviews.length === 0) return { verdict: 'split', votes: { approved: 0, rejected: 0 }, divergences: [] };
    let approved = 0, rejected = 0;
    const div: string[] = [];
    for (const r of reviews) {
        if (r.verdict === 'approved') approved++;
        else {
            rejected++;
            div.push(`[${r.reviewerId}] ${r.notes}`);
        }
    }
    if (approved > 0 && rejected > 0) {
        return { verdict: 'split', votes: { approved, rejected }, divergences: div };
    }
    return {
        verdict: rejected > 0 ? 'rejected' : 'approved',
        votes: { approved, rejected },
        divergences: div
    };
}
