import * as crypto from 'crypto';

interface Entry<T> {
    value: T;
    hash: string;
    savedAt: number;
}

/**
 * Cache em memória invalidado por conteúdo.
 *
 * Cada `put` guarda um hash dos dados de entrada. `get` devolve o valor só
 * quando o hash bate — ou seja, quando o projeto não mudou desde a última
 * análise. Não persiste em disco (é por sessão do VS Code).
 */
export class ContextCache<T = unknown> {
    private store = new Map<string, Entry<T>>();

    private key(namespace: string, key: string): string {
        return namespace + '::' + key;
    }

    static hash(data: unknown): string {
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
    }

    get(namespace: string, key: string, currentHash: string): T | undefined {
        const e = this.store.get(this.key(namespace, key));
        if (!e || e.hash !== currentHash) return undefined;
        return e.value;
    }

    put(namespace: string, key: string, hash: string, value: T): void {
        this.store.set(this.key(namespace, key), {
            value, hash, savedAt: Date.now()
        });
    }

    invalidate(namespace: string, key: string): void {
        this.store.delete(this.key(namespace, key));
    }

    invalidateNamespace(namespace: string): void {
        const prefix = namespace + '::';
        for (const k of this.store.keys()) {
            if (k.startsWith(prefix)) this.store.delete(k);
        }
    }

    clear(): void {
        this.store.clear();
    }

    size(): number {
        return this.store.size;
    }
}
