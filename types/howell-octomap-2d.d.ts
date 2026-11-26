import * as _angular_core from '@angular/core';
import { OnChanges, EventEmitter, SimpleChanges } from '@angular/core';

/**
 * 俯视地图的 PGM 编解码器：写出的是二进制 (P5)，读入兼容 P2 / P5，灰度使用
 * map-server 惯用的 0（占用）/ 254（空闲）两档。
 */
/** 单通道的俯视地图图像（兼容 PGM）。 */
interface OctoMapProjection {
    width: number;
    height: number;
    /** 按行主序排列的像素：{@link PGM_OCCUPIED} 或 {@link PGM_FREE}。 */
    data: Uint8Array;
    /**
     * 一格多少米。PGM 标准头里没有比例尺，本仓把它写进注释行；读外部地图时通常
     * 没有这个值，由宿主另给。
     */
    resolution?: number;
}
/** 黑色——点云的该列中存在点。 */
declare const PGM_OCCUPIED = 0;
/** 白色——点云的该列为空。 */
declare const PGM_FREE = 254;
/**
 * 灰度不高于这个值的像素算「黑」。
 *
 * 编码器只写 0 / 254，所以这个阈值在本仓的图上不会产生歧义；放宽到 127 是为了
 * 接住别处导出的地图（map-server 里还有 205 的未知格，它落在「不黑」的一侧）。
 */
declare const PGM_DARK_MAX = 127;
/**
 * 灰度不低于这个值的像素算「白」——空闲。
 *
 * 与 {@link PGM_DARK_MAX} 之间留出的中间档是「未知」（map-server 写 205）。标准
 * occupancy 图不建议把未知当空闲，所以「白格可走」只认真正的白，中间档照样是障碍。
 */
declare const PGM_FREE_MIN = 250;
/**
 * 把投影序列化为二进制 (P5) PGM 文件。
 *
 * `resolution` 可省略；给了就写进注释行，读回来时可以自动恢复比例尺。PGM 标准
 * 没有这个字段，但注释行允许任意内容，看图的软件会忽略它。
 */
declare function encodePgm(projection: OctoMapProjection, resolution?: number): Uint8Array<ArrayBuffer>;
/**
 * 读入 PGM 文件（P2 文本 / P5 二进制），灰度统一归一化到 0..255。
 *
 * 只认 PGM 自己的头：宽、高、最大灰度。标准头里没有比例尺（map-server 把它放在
 * 同名 YAML 里）；本仓导出时把 `resolution=` 写进了注释行，读到就放进结果的
 * {@link OctoMapProjection.resolution}，读不到就留给宿主另给。
 */
declare function decodePgm(buffer: ArrayBuffer): OctoMapProjection;

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
type OctoMapPgmMode = 'occupiedWalkable' | 'freeWalkable';
/** 两档口径在界面上的短名与说明。 */
declare const OCTO_MAP_PGM_MODE_LABELS: Readonly<Record<OctoMapPgmMode, {
    label: string;
    hint: string;
}>>;
/** PGM 文件头里没有比例尺，一格按多少米算由宿主指定；这是默认值。 */
declare const OCTO_MAP_PGM_DEFAULT_RESOLUTION = 0.05;
/** 建一张二维导航网格需要的参数。 */
interface OctoMapPgmPlanOptions {
    mode: OctoMapPgmMode;
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
interface OctoMapPgmGrid {
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
}
/** 规划成功后的路径。 */
interface OctoMapPgmPath {
    /** 拉直后的格索引（`row * width + col`），首尾是两个吸附后的端点。 */
    cells: number[];
    /** 与 {@link cells} 一一对应的世界坐标，Y 取 {@link OctoMapPgmGrid.groundLevel}。 */
    world: [number, number, number][];
    /** 折线总长（米）。 */
    length: number;
}
/** 规划失败的原因。 */
type OctoMapPgmFailure = 'noStart' | 'noGoal' | 'blockedStart' | 'blockedGoal' | 'unreachable';
/** 一次规划的完整结果。 */
interface OctoMapPgmPlan {
    path: OctoMapPgmPath | null;
    reason: OctoMapPgmFailure | null;
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
    partialPath: OctoMapPgmPath | null;
}
/**
 * 小狗碰撞半径的默认值（米）。
 *
 * 二维库不依赖三维库，所以这里保留与三维默认设置相同的数值（0.25 m）。
 */
declare const OCTO_MAP_PGM_DEFAULT_DOG_RADIUS = 0.25;
/**
 * 终点范围的默认值（米）。
 *
 * 与三维默认设置相同（0.5 m）；起点吸附范围默认也取这个值。
 */
declare const OCTO_MAP_PGM_DEFAULT_GOAL_RADIUS = 0.5;

/**
 * 在一张 PGM 地图上做二维寻路。
 *
 * 输入是一张已经解码好的灰度图 {@link OctoMapProjection}，加一格多少米。建图、膨胀、
 * A*、拉直全在这个目录里，不碰 Three.js、不碰 octo-map 的三维控制器；宿主只负责
 * 把文件读成像素。这样同一份算法既能给 `/system/pgm` 的二维页用，也能在测试里直接
 * `new` 一个网格跑。
 *
 * 与三维寻路共用的是**小狗的形状**：`dogRadius` 决定障碍外扩多少，`goalRadius`
 * 决定终点歪了之后最多吸附多远。二维平面里没有高度与天花板，`maxStepHeight` /
 * `dogHeight` 不参与判定。
 *
 * 交互：左键设起点、右键设终点；**点了「开始寻址」才计算**。点完两个端点后路线不会
 * 自己冒出来，调参数也不会悄悄重算——参数改过就把旧结果清掉，让用户知道该再点一次。
 * 走不通时不只是报错：A* 记下能走到的最远处，面板和画布会标出卡在哪一格。
 */
declare class OctoMapPgmComponent implements OnChanges {
    /** 要寻路的 PGM 图像；为空时只显示一句提示。 */
    image: OctoMapProjection | null;
    /** 一格对应多少米。PGM 文件头不带比例尺，只能由宿主给。 */
    resolution: number;
    /** 小狗碰撞半径（米），决定障碍往外膨胀多少。 */
    dogRadius: number;
    /** 终点范围（米）：点中的格子不可通行时，最多吸附这么远。 */
    goalRadius: number;
    /**
     * 初始通行口径。切换之后由组件自己记（并发出 {@link modeChange}）；父组件再改
     * 这个输入会覆盖当前选择。
     *
     * 默认「黑格可走」，与本仓导出的 PGM 对齐：那里的黑 = 该列有点，正是小狗要走的
     * 地面；从 map-server 换来、墙画成黑色的地图在工具条上切到「白格可走」即可。
     */
    mode: OctoMapPgmMode;
    /** 用户切换通行口径时发出。 */
    readonly modeChange: EventEmitter<OctoMapPgmMode>;
    /** 每次「开始寻址」或清除时发出，供宿主显示或转交。 */
    readonly pathChange: EventEmitter<OctoMapPgmPlan | null>;
    private readonly canvasRef;
    /** 当前通行口径。输入只是初值，选择器改的是这个。 */
    protected readonly activeMode: _angular_core.WritableSignal<OctoMapPgmMode>;
    /** 当前网格；`image` 为空、分辨率无效或建图失败时为空。 */
    protected readonly grid: _angular_core.WritableSignal<OctoMapPgmGrid | null>;
    /** 用户点中的起点 / 终点格（吸附前的原始格）。 */
    private readonly startCell;
    private readonly goalCell;
    /** 最近一次「开始寻址」的结果；null 表示还没算，或端点 / 参数已经改过。 */
    protected readonly plan: _angular_core.WritableSignal<OctoMapPgmPlan | null>;
    /** 起点圆点半径（格）。只影响画出来的标记，不参与寻路。 */
    protected readonly markerSize: _angular_core.WritableSignal<number>;
    /** 起点吸附范围（米）：点中的起点不可走时，最多找这么远。默认跟终点范围一致。 */
    protected readonly startSnapRadius: _angular_core.WritableSignal<number>;
    /**
     * 起点要求的最小净空（米）。比建图时的碰撞半径更严时，起点会被推到离障碍更远的
     * 格子上；小于等于 `dogRadius` 时不生效（路线本身仍按碰撞半径膨胀）。
     */
    protected readonly startClearance: _angular_core.WritableSignal<number>;
    /** 面板里的值一旦被用户改过，就不要再被宿主的新输入或自动默认值覆盖。 */
    private startRadiusTouched;
    private clearanceTouched;
    private markerTouched;
    protected readonly modeOptions: {
        label: string;
        hint: string;
        value: OctoMapPgmMode;
    }[];
    /** 表单事件只放需要从 DOM 上取值的处理器。 */
    protected readonly on: {
        mode: (event: Event) => void;
        markerSize: (event: Event) => void;
        startSnapRadius: (event: Event) => void;
        startClearance: (event: Event) => void;
    };
    constructor();
    ngOnChanges(changes: SimpleChanges): void;
    /** 当前口径的说明，显示在图例旁边。 */
    protected modeHint(): string;
    /** 网格尺寸与分辨率，显示在工具条上。 */
    protected gridInfo(): string | null;
    /** 起点坐标。算过之后显示实际落脚点（吸附后的），否则显示点中的位置。 */
    protected startText(): string;
    /** 终点坐标。算过之后显示实际落点。 */
    protected goalText(): string;
    /** 两个端点都有、且地图可用时才让点「开始寻址」。 */
    protected canSearch(): boolean;
    /** 一句状态：缺什么、为什么失败、或者路多长。 */
    protected statusText(): string;
    protected setMode(value: string): void;
    /** 用户按下「开始寻址」：这时才真的跑一次规划。 */
    protected runSearch(): void;
    protected clearMarks(): void;
    protected onPointerDown(event: PointerEvent): void;
    protected onContextMenu(event: MouseEvent): void;
    private rebuild;
    /** 清掉旧结果；没有结果时什么也不发。 */
    private clearPlan;
    /** 格索引 → 面板上的 `(x, z)`；没有格或没有网格时显示「未设置」。 */
    private coordText;
    /** 起点净空比碰撞半径更严时，失败提示里说明是哪一套口径卡住了。 */
    private clearanceHint;
    /** 走不通时的一句话：最远到哪、还差多远、残段多长。 */
    private unreachableText;
    /** 指针位置 → 网格格索引；落在画布之外返回 null。 */
    private cellFromEvent;
    /**
     * 把网格、路径和两个端点画到画布上。
     *
     * 画布的内部分辨率就是网格的格数，CSS 再把它拉到容器大小：这样每个像素对应一格，
     * 指针换算只要一个比例，不需要沿路反投影。放大用 `image-rendering: pixelated`，
     * 免得浏览器把 5 cm 的格子插值成一片糊。
     *
     * 走不通时多画三样东西：红色残段（从起点到最远处）、卡住点的红叉、以及从卡点到
     * 终点的虚线——虚线标出的是最后没打通的那一段，不是路。
     */
    private draw;
    static ɵfac: _angular_core.ɵɵFactoryDeclaration<OctoMapPgmComponent, never>;
    static ɵcmp: _angular_core.ɵɵComponentDeclaration<OctoMapPgmComponent, "howell-octomap-2d-pgm", never, { "image": { "alias": "image"; "required": false; }; "resolution": { "alias": "resolution"; "required": false; }; "dogRadius": { "alias": "dogRadius"; "required": false; }; "goalRadius": { "alias": "goalRadius"; "required": false; }; "mode": { "alias": "mode"; "required": false; }; }, { "modeChange": "modeChange"; "pathChange": "pathChange"; }, never, never, true, never>;
}

/**
 * 把一张 PGM 图像变成二维导航网格。
 *
 * 像素按 {@link PGM_DARK_MAX} / {@link PGM_FREE_MIN} 分成黑、灰（未知）、白三档，
 * `mode` 决定哪一档可走；两档都不放行中间的灰色。行方向沿用 PGM：第 0 行是 Z 最大
 * 的一侧，与 `projectOccupancy` 的落格规则一致。分辨率（一格多少米）图里没有，由
 * `options.resolution` 给。
 *
 * 像素超过 {@link MAX_PGM_CELLS} 时按整数倍降采样：目标格只要包含一个障碍像素就
 * 整格算障碍（取块内最大值，宁可保守），同时把分辨率乘上同样的倍数，世界尺寸不变。
 *
 * 膨胀半径取 `dogRadius + 半格`，与三维寻路的 `CELL_SAFETY` 同一条理由：判定是格
 * 粒度的，障碍格心到自由格心的距离比「到真实障碍面」多出半格；补半格才能让
 * `blocked` 的边界大致落在真实障碍面上，而不是一律偏保守或偏激进。
 */
declare function buildPgmGrid(image: OctoMapProjection, options: OctoMapPgmPlanOptions): OctoMapPgmGrid;
/**
 * 按小狗的碰撞半径把障碍往外扩。
 *
 * 直接遍历每个障碍格、在它的 `r` 邻域里盖圈，而不是逐格算到最近障碍的距离：前者
 * 的开销跟「障碍格数 × r²」走，后者跟「格数 × r²」走；真图上障碍远比空地少，
 * 而且默认 5 cm 网格、0.25 m 半径时 r 只有 5 格，差别不大。用平方距离比较，
 * 免掉开方。
 */
declare function inflateBlocked(rawBlocked: Uint8Array, width: number, height: number, dogRadius: number, resolution: number): Uint8Array;
/**
 * 在网格上规划一条从 `start` 到 `goal`（都是格索引）的路线。
 *
 * `start` / `goal` 是用户点中的原始格；落在不可通行格上时先吸附到最近的可通行格。
 * 终点用 `goalRadius`——与三维寻路的「终点范围」同一个意思：点歪了半米以内还能救，
 * 点进一整片墙里就直说够不着。
 *
 * 起点另外有 `startRadius`（吸附范围）与 `startClearance`（要求的最小净空）。净空
 * 比建图时的 `dogRadius` 更严时，会在原始障碍上再膨胀一张掩码、只在掩码上找落脚点：
 * 这样「起点要离墙更远」只影响起点，整张图的可走区域不变，路线也不会凭这个参数
 * 变宽。返回的 `startSnapped` 表示起点是否被挪过。
 *
 * 走不通时不只给一个 `'unreachable'`：A* 会顺手记下离终点最近的已探索格，这里把
 * 从起点到那一格的残段拉直后一并返回（`partialPath` / `stuckCell`），界面能把
 * 「走到哪里走不通」画出来。
 */
declare function planPgmPath(grid: OctoMapPgmGrid, start: number | null, goal: number | null, goalRadius: number, startRadius?: number, startClearance?: number | null): OctoMapPgmPlan;
/**
 * 找离 `cell` 最近的、膨胀后仍可通行的格。找不到（`maxCells` 之内全堵着）返回 -1。
 *
 * 逐圈扫描切比雪夫半径：同一圈里有多个空格时取欧氏距离最近的那一个，避免斜着
 * 点一下却吸附到正上方的格子上。范围本身由 `goalRadius` 决定，而不是「一直找到
 * 有空格为止」——后者会把点进墙里的终点悄悄吸附到墙另一侧，画出一条用户没要求的
 * 路线。
 */
declare function snapToFree(grid: OctoMapPgmGrid, cell: number, maxCells: number, blocked?: Uint8Array): number;
/** A* 的完整结果：走到终点时 `cells` 有值，走不到时只有残段与卡住的格。 */
interface PgmSearchResult {
    /** 起点到终点的格序列（含首尾）；走不到为 null。 */
    cells: number[] | null;
    /** 从起点能到达、离终点（按八方向距离）最近的已探索格。 */
    best: number;
    /** 从起点到 {@link best} 的格序列；走到终点时与 {@link cells} 相同。 */
    reachedCells: number[];
}
/**
 * 八邻 A*。
 *
 * 与普通 A* 的差别只有一件：走不到时不是直接返回失败，而是把整片连通区探完，挑
 * 一个启发值最小的已探索格当「最远走到这里」。启发值用的是八方向距离（octile），
 * 对终点而言它是真实距离的下界，所以最小启发值的那一格通常就贴在挡住去路的那堵
 * 墙后面，而不是随便某个边角。
 *
 * 对角移动要求两个正交邻居都可通行：否则路径会从两个对角相贴的障碍之间「挤」过去，
 * 画面上那条斜线正好穿过障碍的角，狗实际上过不去。
 */
declare function searchPgmPath(grid: OctoMapPgmGrid, start: number, goal: number): PgmSearchResult;
/** 只关心「有没有路」的旧入口。 */
declare function findPgmPath(grid: OctoMapPgmGrid, start: number, goal: number): number[] | null;
/**
 * 把 A* 的逐格折线拉直：从当前顶点尽量往前跳，只要两点之间的直线不碰障碍。
 *
 * 八邻 A* 在平地上给出的每一步方向只取决于代价，同一组方向的不同先后完全等价，
 * 于是折线会带出左右翻号的锯齿。拉直不改变「能不能走」——它只删掉中间那些本来
 * 就落在同一条无碰直线上的顶点——但会让小狗少拐很多次头。
 */
declare function smoothPgmPath(grid: OctoMapPgmGrid, cells: number[]): number[];
/**
 * 格索引 → 世界坐标（格心）。
 *
 * 图像行号从上往下涨，而 Z 轴朝上：第 0 行对应 Z 最大的一侧，所以 `row` 要先翻成
 * `height - 1 - row` 再加半格。Y 取地面高度——二维规划不产生高度，路径就画在那个
 * 平面上。
 */
declare function pgmCellToWorld(grid: OctoMapPgmGrid, cell: number): [number, number, number];
/**
 * 世界坐标 (X, Z) → 格索引；落在网格之外返回 null。
 *
 * 这是 {@link pgmCellToWorld} 的逆。宿主（导航页）拿它把三维视图里的位置换算到
 * 二维图上时，也必须遵守「第 0 行是 Z 最大」这一条。
 */
declare function pgmWorldToCell(grid: OctoMapPgmGrid, x: number, z: number): number | null;

export { OCTO_MAP_PGM_DEFAULT_DOG_RADIUS, OCTO_MAP_PGM_DEFAULT_GOAL_RADIUS, OCTO_MAP_PGM_DEFAULT_RESOLUTION, OCTO_MAP_PGM_MODE_LABELS, OctoMapPgmComponent, PGM_DARK_MAX, PGM_FREE, PGM_FREE_MIN, PGM_OCCUPIED, buildPgmGrid, decodePgm, encodePgm, findPgmPath, inflateBlocked, pgmCellToWorld, pgmWorldToCell, planPgmPath, searchPgmPath, smoothPgmPath, snapToFree };
export type { OctoMapPgmFailure, OctoMapPgmGrid, OctoMapPgmMode, OctoMapPgmPath, OctoMapPgmPlan, OctoMapPgmPlanOptions, OctoMapProjection, PgmSearchResult };
//# sourceMappingURL=howell-octomap-2d.d.ts.map
