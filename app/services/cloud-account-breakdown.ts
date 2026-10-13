import client from "./api-client";

/**
 * What one cloud billing account spent its money on: its services, and the
 * resources inside one service. (OP-16)
 *
 * Both come from the cost engine as it is, narrowed to one billing account
 * (invoiceEntityID, the same ID the Cloud Accounts totals are grouped by):
 *  - /cloudCost/view/table?aggregate=service      one row per service
 *  - /cloudCost?aggregate=providerID              one row per resource
 *  - /assets                                      names for cluster servers
 *
 * 🔑 Amounts are net cost (what was charged, after credits), in the account's
 * own billing currency, like the account totals. The services of an account
 * add up to its total for the same window.
 */

export const BREAKDOWN_WINDOWS = [
  { value: "month", label: "This month" },
  { value: "lastmonth", label: "Last month" },
  { value: "7d", label: "Last 7 days" },
] as const;

export type BreakdownWindow = (typeof BREAKDOWN_WINDOWS)[number]["value"];

export interface ServiceCost {
  /** As the provider's bill names it, e.g. AmazonEC2 or "Cloud Firestore". */
  name: string;
  cost: number;
}

export interface ResourceCost {
  /** The provider's own ID: an instance ID, an ARN, a GCP resource path. "" = none. */
  id: string;
  cost: number;
  /** Tags the bill carries for this resource. Often empty. */
  labels: Record<string, string>;
}

/** What the cluster knows about a server, keyed by its instance ID. */
export interface NodeInfo {
  name: string;
  instanceType: string | null;
  /** "spot" or "on-demand", when the node says. */
  capacity: string | null;
}

// A filter value sits inside double quotes in the engine's filter language.
function quoted(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function fetchServices(accountId: string, window: BreakdownWindow): Promise<ServiceCost[]> {
  const resp = await client.get("/cloudCost/view/table", {
    params: {
      window,
      aggregate: "service",
      accumulate: "true",
      costMetric: "netCost",
      limit: 1000,
      filter: `invoiceEntityID:${quoted(accountId)}`,
    },
  });
  const rows: ServiceCost[] = [];
  for (const r of (resp.data?.data ?? []) as { name?: string; cost?: number }[]) {
    const cost = Number(r?.cost);
    if (typeof r?.name === "string" && Number.isFinite(cost)) rows.push({ name: r.name, cost });
  }
  return rows.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
}

interface RawCloudCost {
  properties?: { providerID?: string; labels?: Record<string, string> | null };
  netCost?: { cost?: number };
}

export async function fetchResources(accountId: string, service: string, window: BreakdownWindow): Promise<ResourceCost[]> {
  const resp = await client.get("/cloudCost", {
    params: {
      window,
      aggregate: "providerID",
      accumulate: "true",
      filter: `invoiceEntityID:${quoted(accountId)}+service:${quoted(service)}`,
    },
  });
  // accumulate=true gives one set; add up in case the engine ever returns more.
  const byId = new Map<string, ResourceCost>();
  for (const set of (resp.data?.data?.sets ?? []) as { cloudCosts?: Record<string, RawCloudCost> | null }[]) {
    for (const c of Object.values(set?.cloudCosts ?? {})) {
      const cost = Number(c?.netCost?.cost);
      if (!Number.isFinite(cost)) continue;
      const id = c?.properties?.providerID ?? "";
      const seen = byId.get(id);
      if (seen) seen.cost += cost;
      else byId.set(id, { id, cost, labels: c?.properties?.labels ?? {} });
    }
  }
  return [...byId.values()].sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id));
}

/**
 * Names for the servers that are (or recently were) cluster nodes, by instance
 * ID. A bill only carries the instance ID. A server that never joined the
 * cluster is not in here, and neither is one older than the engine's history.
 * Any failure gives an empty map: names are a help, never a requirement.
 */
export async function fetchNodeNames(window: BreakdownWindow): Promise<Map<string, NodeInfo>> {
  const out = new Map<string, NodeInfo>();
  try {
    const resp = await client.get("/assets", {
      params: { window, accumulate: "true", filter: 'assetType:"node"' },
    });
    const data = resp.data?.data;
    const sets = (Array.isArray(data) ? data : [data]) as (Record<string, unknown> | null)[];
    for (const set of sets) {
      for (const raw of Object.values(set ?? {})) {
        const a = raw as { properties?: { name?: string; providerID?: string }; labels?: Record<string, string> | null };
        const id = a?.properties?.providerID;
        const name = a?.properties?.name;
        if (!id || !name) continue;
        const l = a.labels ?? {};
        const capacity = l.karpenter_sh_capacity_type ?? l.eks_amazonaws_com_capacityType ?? l.capacity_type ?? null;
        out.set(id, {
          name,
          instanceType: l.node_kubernetes_io_instance_type ?? l.beta_kubernetes_io_instance_type ?? null,
          capacity: capacity ? capacity.toLowerCase().replace("_", "-") : null,
        });
      }
    }
  } catch {
    // No names.
  }
  return out;
}

// What a few of the bill's service codes mean. Anything not listed is shown as
// the provider wrote it.
const SERVICE_NAMES: Record<string, string> = {
  AmazonEC2: "EC2: servers, disks, NAT gateway, data transfer",
  AmazonEKS: "EKS: cluster fee",
  AWSELB: "Load balancers",
  AmazonVPC: "VPC: public IP addresses, endpoints",
  AmazonS3: "S3: storage",
  AmazonECR: "ECR: container images",
  AmazonRDS: "RDS: databases",
  AmazonRoute53: "Route 53: DNS",
  AmazonCloudWatch: "CloudWatch: logs, metrics",
  AmazonCloudFront: "CloudFront: CDN",
  AWSSecretsManager: "Secrets Manager",
  awskms: "KMS: encryption keys",
  CodeBuild: "CodeBuild: CI builds",
  AWSCostExplorer: "Cost Explorer API calls",
  AmazonAthena: "Athena: queries",
  AWSGlue: "Glue",
  AWSSystemsManager: "Systems Manager",
};

export function serviceLabel(name: string): string | null {
  return SERVICE_NAMES[name] ?? null;
}

/**
 * The readable end of a resource ID. An ARN's account and region say nothing
 * here (the account is already picked), so only what follows them is kept:
 *   arn:aws:ec2:ap-south-1:123456789012:natgateway/nat-0abc  ->  natgateway/nat-0abc
 *   //bigquery.googleapis.com/projects/p/datasets/d          ->  projects/p/datasets/d
 */
export function shortResourceId(id: string): string {
  const arn = /^arn:[^:]*:[^:]*:[^:]*:[^:]*:(.+)$/.exec(id);
  if (arn) return arn[1];
  const gcp = /^\/\/[^/]+\/(.+)$/.exec(id);
  if (gcp) return gcp[1];
  return id;
}
