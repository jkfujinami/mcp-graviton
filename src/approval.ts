import { AutoApproveRules } from "./types";

export interface IApprovalStrategy {
  shouldAutoApprove(type: string, description: string): boolean;
}

export class ConfigurableApprovalStrategy implements IApprovalStrategy {
  private readonly rules: AutoApproveRules;

  constructor(rules?: AutoApproveRules) {
    // Default to conservative mode (all false) for security
    this.rules = rules || {
      runCommand: false,
      filePermission: false,
      openBrowserUrl: false,
    };
  }

  public shouldAutoApprove(type: string, description: string): boolean {
    if (type === "run_command") {
      return this.rules.runCommand === true || this.rules.runCommand === "always";
    }

    if (type === "file_permission") {
      return this.rules.filePermission === true || this.rules.filePermission === "always";
    }

    if (type === "open_browser_url") {
      return this.rules.openBrowserUrl === true || this.rules.openBrowserUrl === "always";
    }

    return false;
  }
}
