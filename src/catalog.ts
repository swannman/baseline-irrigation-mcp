/**
 * Catalog — resolves companies and controllers for accounts that may span multiple
 * Baseline organizations. The controller is the primary key for every data tool;
 * companies are an enumeration grouping. Everything here is cached for the session.
 *
 * Optional env-driven defaults (see index.ts):
 *   - scopeCompanyId      → restrict enumeration to one org (BASELINE_COMPANY_ID)
 *   - defaultControllerId → controller used when a tool omits controllerId (BASELINE_CONTROLLER_ID)
 */
import type { BaselineClient } from "./client.js";

export interface CompanyRef {
  id: number;
  name: string;
}

export interface ControllerRef {
  controllerId: number;
  name: string;
  mac?: string;
  serialNumber?: string;
  model: string;
  companyId: number;
  companyName: string;
  siteId: number;
  siteName: string;
}

export interface CatalogOptions {
  scopeCompanyId?: number;
  defaultControllerId?: number;
}

export class Catalog {
  private companies: CompanyRef[] | null = null;
  private companyTrees = new Map<number, any>();
  private index: Map<number, ControllerRef> | null = null;
  private companyByController = new Map<number, number>();
  private macByController = new Map<number, string>();

  constructor(
    private readonly client: BaselineClient,
    private readonly opts: CatalogOptions = {},
  ) {}

  /** Companies the account can access (filtered by scopeCompanyId when set). */
  async listCompanies(): Promise<CompanyRef[]> {
    if (!this.companies) {
      const list = await this.client.getJson<any[]>("/baseservice2/companys");
      this.companies = (Array.isArray(list) ? list : []).map((c) => ({
        id: c.id,
        name: c.name,
      }));
    }
    return this.opts.scopeCompanyId != null
      ? this.companies.filter((c) => c.id === this.opts.scopeCompanyId)
      : this.companies;
  }

  /** Full company tree (sites + controllers + device arrays), cached per company. */
  async getCompanyTree(companyId: number): Promise<any> {
    if (!this.companyTrees.has(companyId)) {
      this.companyTrees.set(
        companyId,
        await this.client.getJson(`/baseservice2/companys/${companyId}`),
      );
    }
    return this.companyTrees.get(companyId);
  }

  /** Build (once) the index of every accessible controller across all orgs. */
  async controllerIndex(): Promise<Map<number, ControllerRef>> {
    if (this.index) return this.index;
    const idx = new Map<number, ControllerRef>();
    for (const co of await this.listCompanies()) {
      const tree = await this.getCompanyTree(co.id);
      for (const site of tree.sites ?? []) {
        for (const ctrl of site.controllers ?? []) {
          idx.set(ctrl.id, {
            controllerId: ctrl.id,
            name: ctrl.name,
            mac: ctrl.macaddress,
            serialNumber: ctrl.serialNumber,
            model: modelFromType(ctrl.type),
            companyId: co.id,
            companyName: co.name,
            siteId: site.id,
            siteName: site.name,
          });
          this.companyByController.set(ctrl.id, co.id);
          if (ctrl.macaddress) this.macByController.set(ctrl.id, ctrl.macaddress);
        }
      }
    }
    this.index = idx;
    return idx;
  }

  /** All accessible controllers as a flat list. */
  async listControllers(): Promise<ControllerRef[]> {
    return [...(await this.controllerIndex()).values()];
  }

  /**
   * Resolve a controller id: explicit arg → BASELINE_CONTROLLER_ID → the sole accessible
   * controller. Otherwise throw with the list so the caller can pick.
   */
  async resolveControllerId(given?: number): Promise<number> {
    if (given != null) return given;
    if (this.opts.defaultControllerId != null) return this.opts.defaultControllerId;
    const idx = await this.controllerIndex();
    if (idx.size === 1) return [...idx.keys()][0];
    if (idx.size === 0) throw new Error("No controllers are accessible to this account.");
    const list = [...idx.values()]
      .map((r) => `  - ${r.controllerId}: ${r.name} (${r.companyName} / ${r.siteName})`)
      .join("\n");
    throw new Error(
      `Multiple controllers accessible — pass controllerId or set BASELINE_CONTROLLER_ID.\n${list}`,
    );
  }

  /** Company id that owns a controller (index first, else the controller's backref). */
  async companyIdFor(controllerId: number): Promise<number> {
    const cached = this.companyByController.get(controllerId);
    if (cached != null) return cached;
    await this.controllerIndex();
    const found = this.companyByController.get(controllerId);
    if (found != null) return found;
    // Controller not under an accessible/scoped org (e.g. a pinned id) — use its backref.
    const ctrl = await this.client.getJson<any>(
      `/baseservice2/controllers/${controllerId}`,
    );
    const companyId = ctrl?.site?.company?.id;
    if (companyId == null) {
      throw new Error(`Could not resolve company for controller ${controllerId}.`);
    }
    this.companyByController.set(controllerId, companyId);
    if (ctrl.macaddress) this.macByController.set(controllerId, ctrl.macaddress);
    return companyId;
  }

  /** Full controller object (with populated device arrays) from its company tree. */
  async controllerObject(controllerId: number): Promise<any> {
    const companyId = await this.companyIdFor(controllerId);
    const tree = await this.getCompanyTree(companyId);
    const ctrl = (tree.sites ?? [])
      .flatMap((s: any) => s.controllers ?? [])
      .find((c: any) => c.id === controllerId);
    if (!ctrl) {
      throw new Error(`Controller ${controllerId} not found under company ${companyId}.`);
    }
    return ctrl;
  }

  /** Controller MAC (index/cache first, else the status endpoint). */
  async resolveMac(controllerId: number): Promise<string> {
    const cached = this.macByController.get(controllerId);
    if (cached) return cached;
    const status = await this.client.getJson<{ macaddress?: string }>(
      `/baseservice2/controllers/${controllerId}/status`,
    );
    if (!status.macaddress) {
      throw new Error(`Could not determine MAC for controller ${controllerId}.`);
    }
    this.macByController.set(controllerId, status.macaddress);
    return status.macaddress;
  }

  noteMac(controllerId: number, mac?: string): void {
    if (mac) this.macByController.set(controllerId, mac);
  }
}

function modelFromType(type: unknown): string {
  if (String(type) === "32") return "BaseStation 3200";
  return type == null ? "Unknown" : `type ${type}`;
}
