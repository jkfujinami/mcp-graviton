import fs from "fs";
import path from "path";
import os from "os";
import { SessionMetadata } from "./types";

export interface ISessionPersistence {
  save(metadata: SessionMetadata): Promise<void>;
  load(name: string): Promise<SessionMetadata>;
  delete(name: string): Promise<void>;
  list(): Promise<SessionMetadata[]>;
}

export class FileSessionPersistence implements ISessionPersistence {
  private readonly storageDir: string;

  constructor(customStorageDir?: string) {
    this.storageDir = customStorageDir || path.join(os.homedir(), ".mcp-graviton", "sessions");
    this.ensureDirectory();
  }

  private ensureDirectory() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private getFilePath(name: string): string {
    const safeName = name.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return path.join(this.storageDir, `${safeName}.json`);
  }

  public async save(metadata: SessionMetadata): Promise<void> {
    this.ensureDirectory();
    const filePath = this.getFilePath(metadata.name);
    await fs.promises.writeFile(filePath, JSON.stringify(metadata, null, 2), "utf-8");
  }

  public async load(name: string): Promise<SessionMetadata> {
    const filePath = this.getFilePath(name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Session file not found for: ${name}`);
    }
    const data = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(data) as SessionMetadata;
  }

  public async delete(name: string): Promise<void> {
    const filePath = this.getFilePath(name);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }

  public async list(): Promise<SessionMetadata[]> {
    this.ensureDirectory();
    const files = await fs.promises.readdir(this.storageDir);
    const jsonFiles = files.filter((f: string) => f.endsWith(".json"));
    const list: SessionMetadata[] = [];

    for (const file of jsonFiles) {
      try {
        const data = await fs.promises.readFile(path.join(this.storageDir, file), "utf-8");
        list.push(JSON.parse(data) as SessionMetadata);
      } catch (e) {
        // Skip corrupted or unreadable session files
      }
    }
    return list;
  }
}
