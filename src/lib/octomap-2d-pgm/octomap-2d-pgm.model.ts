/**
 * 在 PGM 地图上寻路时，「可走」取哪一层语义。
 *
 * PGM 里只有灰度，没有高度。本仓导出的俯视投影用 0（黑）表示该列有点、254（白）
 * 表示空列；别处导出的 map-server 地图则常把黑画成墙。黑白哪个能走没有唯一答案，
 * 所以不替用户定，交给 `mode`：
 *
 * - `'occupiedWalkable'`：**黑格可走**，白格是障碍。适合本仓导出的投影——小狗走在
 *   云点覆盖到的那张面上，碰撞半径从空洞边缘往里让。
 * - `'freeWalkable'`：**白格可走**，黑格是障碍。标准占用图语义，适合墙是黑色的
 *   地图（ROS map-server 导出的大多是这一种）。
 *
 * 原先还有一档「按高度分带」，它需要每个像素的最高点；PGM 不带高度，于是二维页
 * 只保留这两档。高度分带仍留在三维寻路那边。
 */
export type OctomapPgmMode = 'occupiedWalkable' | 'freeWalkable';

/** 两档口径在界面上的短名与说明。 */
export const OCTOMAP_PGM_MODE_LABELS: Readonly<
  Record<OctomapPgmMode, { label: string; hint: string }>
> = {
  occupiedWalkable: {
    label: '黑格可走',
    hint: '黑色（有点）可走，白色是障碍；碰撞半径从白色一侧往里让。',
  },
  freeWalkable: {
    label: '白格可走',
    hint: '标准占用图：白色可走，黑色（墙）与灰色（未知）都是障碍。',
  },
};

/** PGM 文件头里没有比例尺，一格按多少米算由宿主指定；这是默认值。 */
export const OCTOMAP_PGM_DEFAULT_RESOLUTION = 0.05;

/** 建一张二维导航网格需要的参数。 */
export interface OctomapPgmPlanOptions {
  mode: OctomapPgmMode;
  /**
   * 小狗的碰撞半径（米），与三维寻路共用设置面板里那一项。
   *
   * 二维里它只决定「障碍往外膨胀多少」：路径格心到任一障碍格的距离必须不小于
   * `dogRadius`。高度（`dogHeight`）在二维平面里没有对应物，不参与判定。
   */
  dogRadius: number;
  /** 一格对应多少米。PGM 文件头里没有这个数。 */
  resolution: number;
}

/** 一张二维导航网格。行列按图像方向：`row = 0` 是 Z 最大的一侧。 */
export interface OctomapPgmGrid {
  width: number;
  height: number;
  /** 一格多宽（世界单位）。图像被降采样时已经乘过倍数。 */
  resolution: number;
  /** 网格原点（世界 X / Z 的最小值）。 */
  minX: number;
  minZ: number;
  /** 地图平面高度（世界 Y），也是路径点的 Y；PGM 没有高度，固定 0。 */
  groundLevel: number;
  /** 建图时用的碰撞半径（米），即 {@link blocked} 的膨胀半径。 */
  dogRadius: number;
  /** 膨胀前的不可通行格，按 PGM 的行主序排列。 */
  rawBlocked: Uint8Array;
  /** 按 `dogRadius + 半格` 膨胀后的不可通行格。 */
  blocked: Uint8Array;
  /**
   * 底图：降采样后的原始灰度（每格取块内最暗的像素）。
   *
   * 绘制时先铺这一层，再叠碰撞膨胀/路径/端点。它**不随通行口径变化**——切
   * `mode` 只改哪些格算障碍，不改 PGM 自己的黑白。
   */
  base: Uint8Array;
}

/** 规划成功后的路径。 */
export interface OctomapPgmPath {
  /** 拉直后的格索引（`row * width + col`），首尾是两个吸附后的端点。 */
  cells: number[];
  /** 与 {@link cells} 一一对应的世界坐标，Y 取 {@link OctomapPgmGrid.groundLevel}。 */
  world: [number, number, number][];
  /** 折线总长（米）。 */
  length: number;
}

/** 规划失败的原因。 */
export type OctomapPgmFailure =
  | 'noStart'
  | 'noGoal'
  | 'blockedStart'
  | 'blockedGoal'
  | 'unreachable';

/** 一次规划的完整结果。 */
export interface OctomapPgmPlan {
  path: OctomapPgmPath | null;
  reason: OctomapPgmFailure | null;
  /** 吸附后的起点格；没点过或格子为空时为 null。 */
  startCell: number | null;
  goalCell: number | null;
  /** 起点 / 终点是否被吸附过（点在了不可通行的格子上）。 */
  startSnapped: boolean;
  goalSnapped: boolean;
  /**
   * 走不通时：从起点出发、能走到的离终点最近的格；其他情况为 null。
   *
   * A* 把整片连通区探完之后挑的是启发值（到终点的最短距离下界）最小的已探索格，
   * 所以它通常就贴着「差一步就能过去」的那堵墙。
   */
  stuckCell: number | null;
  /** 走不通时：从起点到 {@link stuckCell} 的残段（已拉直）；其他情况为 null。 */
  partialPath: OctomapPgmPath | null;
}

/**
 * 小狗碰撞半径的默认值（米）。
 *
 * 二维库不依赖三维库，所以这里保留与三维默认设置相同的数值（0.25 m）。
 */
export const OCTOMAP_PGM_DEFAULT_DOG_RADIUS = 0.25;

/**
 * 终点范围的默认值（米）。
 *
 * 与三维默认设置相同（0.5 m）；起点吸附范围默认也取这个值。
 */
export const OCTOMAP_PGM_DEFAULT_GOAL_RADIUS = 0.5;

/**
 * 组件对外的只读状态快照。
 *
 * 二维组件本身不画设置面板；宿主（比如 test 的 `d2-settings`）读这个快照来显示
 * 网格信息、起终点读数、状态文字和实际生效的起点圆点大小。`markerSize` 为 `null`
 * 时表示组件按地图尺寸自动取值。
 */
export interface OctomapPgmViewState {
  grid: { width: number; height: number; resolution: number } | null;
  startCell: number | null;
  goalCell: number | null;
  plan: OctomapPgmPlan | null;
  canSearch: boolean;
  gridInfo: string | null;
  startText: string;
  goalText: string;
  status: string;
  markerSize: number | null;
}
