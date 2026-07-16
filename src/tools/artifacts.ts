import crypto from "node:crypto";

export type ArtifactKind = "document" | "table" | "prototype";

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  teamId: string;
  boardId: string;
  itemId?: string;
  title: string;
  version: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, Artifact>();

  create(
    input: Omit<Artifact, "id" | "version" | "createdAt" | "updatedAt">,
  ): Artifact {
    const now = new Date().toISOString();
    const artifact: Artifact = {
      ...input,
      id: crypto.randomUUID(),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  get(id: string, teamId: string): Artifact | undefined {
    const value = this.artifacts.get(id);
    return value?.teamId === teamId ? value : undefined;
  }

  findByItem(itemId: string, teamId: string): Artifact | undefined {
    return [...this.artifacts.values()].find(
      (value) => value.teamId === teamId && value.itemId === itemId,
    );
  }

  list(teamId: string, boardId?: string, kind?: ArtifactKind): Artifact[] {
    return [...this.artifacts.values()].filter(
      (value) =>
        value.teamId === teamId &&
        (!boardId || value.boardId === boardId) &&
        (!kind || value.kind === kind),
    );
  }

  update(
    id: string,
    teamId: string,
    updater: (artifact: Artifact) => Record<string, unknown>,
  ): Artifact | undefined {
    const value = this.get(id, teamId);
    if (!value) return undefined;
    value.data = updater(value);
    value.version += 1;
    value.updatedAt = new Date().toISOString();
    return value;
  }
}
