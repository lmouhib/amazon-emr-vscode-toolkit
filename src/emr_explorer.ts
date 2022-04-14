import * as vscode from "vscode";
import {
  EMR,
  ListClustersCommand,
  ClusterState,
  DescribeClusterCommand,
  Application,
  ClusterSummary,
  InstanceCollectionType,
  ListInstanceGroupsCommand,
  ListInstanceFleetsCommand,
  InstanceFleetStatus,
  Cluster,
  ListInstancesCommand,
  InstanceTypeSpecification,
  InstanceGroupType,
  InstanceStateChangeReason,
  InstanceState,
  InstanceFleetType,
} from "@aws-sdk/client-emr";

export class NodeDependenciesProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  emrClient: EMR;
  private _onDidChangeTreeData: vscode.EventEmitter<
    EMRCluster | undefined | null | void
  > = new vscode.EventEmitter<EMRCluster | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    EMRCluster | undefined | null | void
  > = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  constructor(private workspaceRoot: string) {
    this.emrClient = new EMR({ region: "us-west-2" });
  }

  getTreeItem(element: EMRCluster): vscode.TreeItem {
    return element;
  }

  getChildren(element?: EMRCluster): Thenable<vscode.TreeItem[]> {
    if (element) {
      return Promise.resolve(element.getChildren());
    } else {
      return Promise.resolve(this.listEMRClusters(this.emrClient));
    }
  }

  private async listEMRClusters(client: EMR): Promise<EMRCluster[]> {
    // Currently only show running or waiting clusters
    const params = {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      ClusterStates: [ClusterState.RUNNING, ClusterState.WAITING],
    };
    vscode.window.showInformationMessage(
      "Fetching running and waiting clusters"
    );
    try {
      const result = await client.send(new ListClustersCommand(params));
      return (result.Clusters || []).map((cluster) => {
        return new EMRCluster(
          cluster,
          this.emrClient,
          vscode.TreeItemCollapsibleState.Collapsed
        );
      });
    } catch (e) {
      vscode.window.showErrorMessage("Bummer!" + e);
      console.log("There was an error fetching clusters", e);
      return [];
    }
  }
}

class EMRCluster extends vscode.TreeItem {
  constructor(
    private readonly details: ClusterSummary,
    private readonly emr: EMR,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(details.Name || "No name", collapsibleState);
    this.tooltip = `${details.Name} (${details.Id})`;
    this.description = details.Id;
  }

  public async getChildren(element?: EMRCluster): Promise<vscode.TreeItem[]> {
    const response = await this.emr.send(
      // eslint-disable-next-line @typescript-eslint/naming-convention
      new DescribeClusterCommand({ ClusterId: this.details.Id })
    );
    // TODO (2022-04-13): ERROR CHECKING!
    console.log(response);
    return [
      new EMRClusterApps(
        this.emr,
        response.Cluster ? response.Cluster.Applications : undefined
      ),
      new EMRClusterInstances(
        this.emr, response.Cluster!,
      ),
    ];
  }
}

class EMRClusterApps extends vscode.TreeItem {
  constructor(
    private readonly emr: EMR,
    private readonly apps: Application[] | undefined
  ) {
    super("Apps", vscode.TreeItemCollapsibleState.Collapsed);
  }

  getTreeItem(element: EMRClusterApps): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return (this.apps || []).map((item) => new EMRAppNode(item));
  }
}

class EMRClusterInstances extends vscode.TreeItem {
  constructor(
    private readonly emr: EMR,
    private readonly cluster: Cluster,
  ) {
    super("Instances", vscode.TreeItemCollapsibleState.Collapsed);

    this.cluster = cluster;
  }

  getTreeItem(element: EMRClusterInstances): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: EMRClusterInstances|undefined): Promise<vscode.TreeItem[]> {
    // TODO (2022-04-13): Pagination
    let instanceCollectionMapping: Map<string, string[]> = new Map();
    
    if (this.cluster.InstanceCollectionType === InstanceCollectionType.INSTANCE_GROUP) {
      const response = await this.emr.send(
        new ListInstanceGroupsCommand({ ClusterId: this.cluster.Id })
      );
      instanceCollectionMapping.set("master", response.InstanceGroups?.filter(item => item.InstanceGroupType === InstanceGroupType.MASTER).map(item => item.Id as string) || []);
      instanceCollectionMapping.set("core", response.InstanceGroups?.filter(item => item.InstanceGroupType === InstanceGroupType.CORE).map(item => item.Id as string) || []);
      instanceCollectionMapping.set("task", response.InstanceGroups?.filter(item => item.InstanceGroupType === InstanceGroupType.TASK).map(item => item.Id as string) || []);
      
    } else if (
      this.cluster.InstanceCollectionType === InstanceCollectionType.INSTANCE_FLEET
    ) {
      const response = await this.emr.send(
        new ListInstanceFleetsCommand({ ClusterId: this.cluster.Id })
      );
      instanceCollectionMapping.set("master", response.InstanceFleets?.filter(item => item.InstanceFleetType === InstanceFleetType.MASTER).map(item => item.Id as string) || []);
      instanceCollectionMapping.set("core", response.InstanceFleets?.filter(item => item.InstanceFleetType === InstanceGroupType.CORE).map(item => item.Id as string) || []);
      instanceCollectionMapping.set("task", response.InstanceFleets?.filter(item => item.InstanceFleetType === InstanceGroupType.TASK).map(item => item.Id as string) || []);
    }

    const instances = await this.emr.send(
      new ListInstancesCommand({ClusterId: this.cluster.Id, InstanceStates: [InstanceState.RUNNING, InstanceState.BOOTSTRAPPING, InstanceState.PROVISIONING]})
    );

    const instanceTypeMapping = {
      master: instances.Instances?.filter(item => instanceCollectionMapping.get("master")?.includes(item.InstanceGroupId!) ),
      core: instances.Instances?.filter(item => instanceCollectionMapping.get("core")?.includes(item.InstanceGroupId!)),
      task: instances.Instances?.filter(item => instanceCollectionMapping.get("task")?.includes(item.InstanceGroupId!)),
    };

    return [
      new InstanceNodeTree(
        "Primary",
        instanceTypeMapping.master?.map(item => new InstanceNodeTree(item.Ec2InstanceId!, undefined, item.InstanceType)),
      ),
      new InstanceNodeTree(
        "Core",
        instanceTypeMapping.core?.map(item => new InstanceNodeTree(item.Ec2InstanceId!, undefined, item.InstanceType)),
      ),
      new InstanceNodeTree(
        "Task",
        instanceTypeMapping.task?.map(item => new InstanceNodeTree(item.Ec2InstanceId!, undefined, item.InstanceType)),
      ),
    ];
  }
}

class EMRAppNode extends vscode.TreeItem {
  constructor(private readonly app: Application) {
    super(app.Name || "Unknown");
    this.description = app.Version;
  }
}

class InstanceNodeTree extends vscode.TreeItem {
  children: InstanceNodeTree[]|undefined;

  constructor(label: string, children?: InstanceNodeTree[], description?: string) {
    super(label, children === undefined ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed)
    this.children = children;
    if (description) { this.description = description;}
  }

  getChildren(element?: InstanceNodeTree): InstanceNodeTree[] {
    return this.children || [];
  }

}