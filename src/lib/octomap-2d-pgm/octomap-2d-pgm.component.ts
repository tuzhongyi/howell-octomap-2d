import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  effect,
  signal,
  viewChild,
} from '@angular/core';
import { OctoMapProjection } from '../utils/pgm.util';
import {
  OCTO_MAP_PGM_DEFAULT_DOG_RADIUS,
  OCTO_MAP_PGM_DEFAULT_GOAL_RADIUS,
  OCTO_MAP_PGM_DEFAULT_RESOLUTION,
  OCTO_MAP_PGM_MODE_LABELS,
  OctoMapPgmGrid,
  OctoMapPgmMode,
  OctoMapPgmPlan,
} from './octomap-2d-pgm.model';
import { buildPgmGrid, pgmCellToWorld, planPgmPath } from './octomap-2d-pgm-grid';

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
@Component({
  selector: 'howell-octomap-2d-pgm',
  imports: [],
  templateUrl: './octomap-2d-pgm.component.html',
  styleUrl: './octomap-2d-pgm.component.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OctoMapPgmComponent implements OnChanges {
  /** 要寻路的 PGM 图像；为空时只显示一句提示。 */
  @Input() image: OctoMapProjection | null = null;

  /** 一格对应多少米。PGM 文件头不带比例尺，只能由宿主给。 */
  @Input() resolution: number = OCTO_MAP_PGM_DEFAULT_RESOLUTION;

  /** 小狗碰撞半径（米），决定障碍往外膨胀多少。 */
  @Input() dogRadius: number = OCTO_MAP_PGM_DEFAULT_DOG_RADIUS;

  /** 终点范围（米）：点中的格子不可通行时，最多吸附这么远。 */
  @Input() goalRadius: number = OCTO_MAP_PGM_DEFAULT_GOAL_RADIUS;

  /**
   * 初始通行口径。切换之后由组件自己记（并发出 {@link modeChange}）；父组件再改
   * 这个输入会覆盖当前选择。
   *
   * 默认「黑格可走」，与本仓导出的 PGM 对齐：那里的黑 = 该列有点，正是小狗要走的
   * 地面；从 map-server 换来、墙画成黑色的地图在工具条上切到「白格可走」即可。
   */
  @Input() mode: OctoMapPgmMode = 'occupiedWalkable';

  /** 用户切换通行口径时发出。 */
  @Output() readonly modeChange = new EventEmitter<OctoMapPgmMode>();

  /** 每次「开始寻址」或清除时发出，供宿主显示或转交。 */
  @Output() readonly pathChange = new EventEmitter<OctoMapPgmPlan | null>();

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  /** 当前通行口径。输入只是初值，选择器改的是这个。 */
  protected readonly activeMode = signal<OctoMapPgmMode>('occupiedWalkable');

  /** 当前网格；`image` 为空、分辨率无效或建图失败时为空。 */
  protected readonly grid = signal<OctoMapPgmGrid | null>(null);

  /** 用户点中的起点 / 终点格（吸附前的原始格）。 */
  private readonly startCell = signal<number | null>(null);
  private readonly goalCell = signal<number | null>(null);

  /** 最近一次「开始寻址」的结果；null 表示还没算，或端点 / 参数已经改过。 */
  protected readonly plan = signal<OctoMapPgmPlan | null>(null);

  /** 起点圆点半径（格）。只影响画出来的标记，不参与寻路。 */
  protected readonly markerSize = signal(10);

  /** 起点吸附范围（米）：点中的起点不可走时，最多找这么远。默认跟终点范围一致。 */
  protected readonly startSnapRadius = signal(OCTO_MAP_PGM_DEFAULT_GOAL_RADIUS);

  /**
   * 起点要求的最小净空（米）。比建图时的碰撞半径更严时，起点会被推到离障碍更远的
   * 格子上；小于等于 `dogRadius` 时不生效（路线本身仍按碰撞半径膨胀）。
   */
  protected readonly startClearance = signal(OCTO_MAP_PGM_DEFAULT_DOG_RADIUS);

  /** 面板里的值一旦被用户改过，就不要再被宿主的新输入或自动默认值覆盖。 */
  private startRadiusTouched = false;
  private clearanceTouched = false;
  private markerTouched = false;

  protected readonly modeOptions = (
    Object.keys(OCTO_MAP_PGM_MODE_LABELS) as OctoMapPgmMode[]
  ).map((value) => ({ value, ...OCTO_MAP_PGM_MODE_LABELS[value] }));

  /** 表单事件只放需要从 DOM 上取值的处理器。 */
  protected readonly on = {
    mode: (event: Event): void => {
      this.setMode((event.target as HTMLSelectElement).value);
    },
    markerSize: (event: Event): void => {
      this.markerTouched = true;
      this.markerSize.set(readNumber(event, this.markerSize(), 1));
    },
    startSnapRadius: (event: Event): void => {
      this.startRadiusTouched = true;
      this.startSnapRadius.set(readNumber(event, this.startSnapRadius(), 0));
      this.clearPlan();
    },
    startClearance: (event: Event): void => {
      this.clearanceTouched = true;
      this.startClearance.set(readNumber(event, this.startClearance(), 0));
      this.clearPlan();
    },
  };

  constructor() {
    effect(() => this.draw());
  }

  ngOnChanges(changes: SimpleChanges): void {
    let rebuild = false;
    if (changes['image']) {
      // 换了一张图，旧的起终点指的是另一张图上的格子，留着只会画出一条莫名其妙的线。
      this.startCell.set(null);
      this.goalCell.set(null);
      rebuild = true;
    }
    if (changes['mode']) {
      this.activeMode.set(this.mode);
      rebuild = true;
    }
    if (changes['dogRadius']) {
      if (!this.clearanceTouched) {
        this.startClearance.set(this.dogRadius);
      }
      rebuild = true;
    }
    if (changes['resolution']) {
      rebuild = true;
    }
    if (changes['goalRadius']) {
      if (!this.startRadiusTouched) {
        this.startSnapRadius.set(this.goalRadius);
      }
      // 终点范围参与规划，换了就得重算，旧结果不能留。
      this.clearPlan();
    }
    if (rebuild) {
      this.rebuild();
    }
  }

  /** 当前口径的说明，显示在图例旁边。 */
  protected modeHint(): string {
    return OCTO_MAP_PGM_MODE_LABELS[this.activeMode()].hint;
  }

  /** 网格尺寸与分辨率，显示在工具条上。 */
  protected gridInfo(): string | null {
    const grid = this.grid();
    if (!grid) {
      return null;
    }
    return `${grid.width} × ${grid.height} 格 · 每格 ${(grid.resolution * 100).toFixed(2)} cm`;
  }

  /** 起点坐标。算过之后显示实际落脚点（吸附后的），否则显示点中的位置。 */
  protected startText(): string {
    return this.coordText(this.plan()?.startCell ?? this.startCell());
  }

  /** 终点坐标。算过之后显示实际落点。 */
  protected goalText(): string {
    return this.coordText(this.plan()?.goalCell ?? this.goalCell());
  }

  /** 两个端点都有、且地图可用时才让点「开始寻址」。 */
  protected canSearch(): boolean {
    return this.grid() !== null && this.startCell() !== null && this.goalCell() !== null;
  }

  /** 一句状态：缺什么、为什么失败、或者路多长。 */
  protected statusText(): string {
    const grid = this.grid();
    if (!grid) {
      return '没有可用的 PGM 地图。先在工具条上加载一个 .pgm 文件。';
    }
    const plan = this.plan();
    if (!plan) {
      if (this.startCell() === null) {
        return '左键在图上点一下设起点。';
      }
      if (this.goalCell() === null) {
        return '右键在图上点一下设终点。';
      }
      return '点「开始寻址」计算路线。';
    }
    switch (plan.reason) {
      case 'noStart':
        return '左键在图上点一下设起点。';
      case 'noGoal':
        return '右键在图上点一下设终点。';
      case 'blockedStart':
        return `起点附近 ${this.startSnapRadius().toFixed(2)} m 内没有${this.clearanceHint()}可通行的格子。`;
      case 'blockedGoal':
        return `终点附近 ${this.goalRadius.toFixed(2)} m 内没有可通行的格子。`;
      case 'unreachable':
        return this.unreachableText(grid, plan);
      default:
        break;
    }
    if (plan.path) {
      const snapped: string[] = [];
      if (plan.startSnapped) {
        snapped.push('起点');
      }
      if (plan.goalSnapped) {
        snapped.push('终点');
      }
      const snapText = snapped.length > 0 ? `（${snapped.join('、')}已吸附到最近的可通行格）` : '';
      return `路径 ${plan.path.cells.length} 点 · 长 ${plan.path.length.toFixed(2)} m${snapText}`;
    }
    return '';
  }

  protected setMode(value: string): void {
    const mode = value as OctoMapPgmMode;
    if (mode === this.activeMode()) {
      return;
    }
    this.activeMode.set(mode);
    this.modeChange.emit(mode);
    this.rebuild();
  }

  /** 用户按下「开始寻址」：这时才真的跑一次规划。 */
  protected runSearch(): void {
    const grid = this.grid();
    if (!grid) {
      return;
    }
    const plan = planPgmPath(
      grid,
      this.startCell(),
      this.goalCell(),
      this.goalRadius,
      this.startSnapRadius(),
      this.startClearance(),
    );
    this.plan.set(plan);
    this.pathChange.emit(plan);
  }

  protected clearMarks(): void {
    this.startCell.set(null);
    this.goalCell.set(null);
    this.clearPlan();
  }

  protected onPointerDown(event: PointerEvent): void {
    const grid = this.grid();
    if (!grid) {
      return;
    }
    const cell = this.cellFromEvent(event, grid);
    if (cell === null) {
      return;
    }
    event.preventDefault();
    if (event.button === 2) {
      this.goalCell.set(cell);
    } else if (event.button === 0) {
      this.startCell.set(cell);
    } else {
      return;
    }
    // 端点换了，旧路线就作废；按钮仍在，用户想算再点一次。
    this.clearPlan();
  }

  protected onContextMenu(event: MouseEvent): void {
    // 右键用来设终点，不能让浏览器菜单盖上来。
    event.preventDefault();
  }

  private rebuild(): void {
    this.clearPlan();
    const image = this.image;
    // 分辨率为 0 或 NaN 时膨胀半径会变成 Infinity，整张图都会被判成障碍——宁可
    // 退回「没有地图」，等宿主把数字改对。
    if (!image || !(this.resolution > 0)) {
      this.grid.set(null);
      return;
    }
    const grid = buildPgmGrid(image, {
      mode: this.activeMode(),
      dogRadius: this.dogRadius,
      resolution: this.resolution,
    });
    this.grid.set(grid);
    if (!this.markerTouched) {
      // 默认圆点跟着地图大小走：小图不至于糊住起点，大图也不至于看不见。
      this.markerSize.set(autoMarkerSize(grid));
    }
  }

  /** 清掉旧结果；没有结果时什么也不发。 */
  private clearPlan(): void {
    if (this.plan() === null) {
      return;
    }
    this.plan.set(null);
    this.pathChange.emit(null);
  }

  /** 格索引 → 面板上的 `(x, z)`；没有格或没有网格时显示「未设置」。 */
  private coordText(cell: number | null): string {
    const grid = this.grid();
    if (!grid || cell === null) {
      return '未设置';
    }
    const world = pgmCellToWorld(grid, cell);
    return `(${world[0].toFixed(2)}, ${world[2].toFixed(2)})`;
  }

  /** 起点净空比碰撞半径更严时，失败提示里说明是哪一套口径卡住了。 */
  private clearanceHint(): string {
    return this.startClearance() > this.dogRadius ? '满足起点净空的' : '';
  }

  /** 走不通时的一句话：最远到哪、还差多远、残段多长。 */
  private unreachableText(grid: OctoMapPgmGrid, plan: OctoMapPgmPlan): string {
    if (plan.stuckCell === null || plan.goalCell === null) {
      return '走不通：两点之间没有可行路线（障碍或碰撞膨胀把路封住了）。';
    }
    const stuck = pgmCellToWorld(grid, plan.stuckCell);
    const goal = pgmCellToWorld(grid, plan.goalCell);
    const gap = Math.hypot(goal[0] - stuck[0], goal[2] - stuck[2]);
    const walked = plan.partialPath?.length ?? 0;
    return (
      `走不通：走到 (${stuck[0].toFixed(2)}, ${stuck[2].toFixed(2)}) 被挡住，` +
      `离终点还有 ${gap.toFixed(2)} m（残段 ${walked.toFixed(2)} m）。`
    );
  }

  /** 指针位置 → 网格格索引；落在画布之外返回 null。 */
  private cellFromEvent(event: PointerEvent, grid: OctoMapPgmGrid): number | null {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    // 画布在 CSS 里是 `width/height: 100% + object-fit: contain`：元素盒子铺满容器，
    // 图本身按比例居中留边。指针换算必须用**图的内容框**，不能用元素矩形，否则
    // 长宽比不一致时点哪儿都偏。
    const scale = Math.min(rect.width / grid.width, rect.height / grid.height);
    if (scale <= 0) {
      return null;
    }
    const offsetX = rect.left + (rect.width - grid.width * scale) / 2;
    const offsetY = rect.top + (rect.height - grid.height * scale) / 2;
    const col = Math.floor((event.clientX - offsetX) / scale);
    const row = Math.floor((event.clientY - offsetY) / scale);
    if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) {
      return null;
    }
    return row * grid.width + col;
  }

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
  private draw(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    const grid = this.grid();
    if (!grid) {
      canvas.width = 1;
      canvas.height = 1;
      return;
    }
    if (canvas.width !== grid.width || canvas.height !== grid.height) {
      canvas.width = grid.width;
      canvas.height = grid.height;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const image = context.createImageData(grid.width, grid.height);
    const data = image.data;
    for (let i = 0; i < grid.blocked.length; i++) {
      const p = i * 4;
      if (grid.rawBlocked[i] !== 0) {
        // 原始障碍：深灰，不用纯黑——路径与端点要压在上面才看得清。
        data[p] = 31;
        data[p + 1] = 41;
        data[p + 2] = 55;
      } else if (grid.blocked[i] !== 0) {
        // 只因为碰撞半径而不可走的格子：浅红。调小半径时它会缩回去，用户能直接
        // 看到「小狗的碰撞」在二维图上值多少格。
        data[p] = 254;
        data[p + 1] = 202;
        data[p + 2] = 202;
      } else {
        data[p] = 248;
        data[p + 1] = 250;
        data[p + 2] = 252;
      }
      data[p + 3] = 255;
    }
    context.putImageData(image, 0, 0);

    const plan = this.plan();
    const thinLine = Math.max(1.2, Math.min(grid.width, grid.height) / 220);
    context.lineCap = 'round';
    context.lineJoin = 'round';

    if (plan?.path) {
      const points = cellPoints(grid, plan.path.cells);
      // 白色描边垫底：路径经过深灰障碍边缘时仍然看得见。
      context.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      context.lineWidth = Math.max(2.5, Math.min(grid.width, grid.height) / 90);
      tracePath(context, points);
      context.stroke();
      context.strokeStyle = '#2563eb';
      context.lineWidth = thinLine;
      tracePath(context, points);
      context.stroke();
    }

    const partial = plan?.partialPath;
    if (partial && partial.cells.length > 1) {
      const points = cellPoints(grid, partial.cells);
      context.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      context.lineWidth = Math.max(2.5, Math.min(grid.width, grid.height) / 90);
      tracePath(context, points);
      context.stroke();
      context.strokeStyle = '#dc2626';
      context.lineWidth = thinLine;
      tracePath(context, points);
      context.stroke();
    }

    if (plan && plan.stuckCell !== null && plan.goalCell !== null) {
      // 卡点 → 终点：虚线只表示「差的这一段没打通」，不能当成可走路线。
      const from = cellCenter(grid, plan.stuckCell);
      const to = cellCenter(grid, plan.goalCell);
      context.save();
      const dash = Math.max(2, Math.min(grid.width, grid.height) / 100);
      context.setLineDash([dash, dash]);
      context.strokeStyle = 'rgba(220, 38, 38, 0.75)';
      context.lineWidth = Math.max(1, Math.min(grid.width, grid.height) / 300);
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      context.restore();
    }

    // 点下就画。只设了一个端点时 `plan` 还是为空，只看 plan 的话第一下点击没有
    // 任何反馈；这里以用户原始点中的格为准，吸附成功时仍画在路径真正的落点上。
    const start = this.startCell();
    const goal = this.goalCell();
    if (start !== null) {
      drawMarker(
        context,
        grid,
        plan?.startCell ?? start,
        '#16a34a',
        this.startClearance(),
        this.markerSize(),
      );
    }
    if (goal !== null) {
      drawMarker(context, grid, plan?.goalCell ?? goal, '#f59e0b', 0);
    }

    if (plan && plan.stuckCell !== null) {
      drawStuckCross(context, grid, plan.stuckCell);
    }
  }
}

/** 「起点大小」的自动值：短边的 1/120，与原来固定圆点的观感一致。 */
function autoMarkerSize(grid: OctoMapPgmGrid): number {
  return Math.max(1, Math.round(Math.min(grid.width, grid.height) / 120));
}

/** 从输入框里读一个有限的非负数；非法时回填 `fallback`，并且不改信号。 */
function readNumber(event: Event, fallback: number, min: number): number {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < min) {
    input.value = String(fallback);
    return fallback;
  }
  return value;
}

/** 格索引序列 → 画布上的格心坐标（1 格 = 1 像素）。 */
function cellPoints(
  grid: OctoMapPgmGrid,
  cells: readonly number[],
): { x: number; y: number }[] {
  return cells.map((cell) => cellCenter(grid, cell));
}

function cellCenter(grid: OctoMapPgmGrid, cell: number): { x: number; y: number } {
  return {
    x: (cell % grid.width) + 0.5,
    y: ((cell / grid.width) | 0) + 0.5,
  };
}

/** 把一串格心连成路径，不额外提交 stroke——调用方决定描边宽度与颜色。 */
function tracePath(
  context: CanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
): void {
  context.beginPath();
  for (let i = 0; i < points.length; i++) {
    if (i === 0) {
      context.moveTo(points[i].x, points[i].y);
    } else {
      context.lineTo(points[i].x, points[i].y);
    }
  }
}

/**
 * 端点标记。`footprintRadius` > 0 时额外画一圈碰撞足迹：起点那一圈就是小狗在二维
 * 图上占的地方，用户调「起点碰撞」时它跟着变。`dotRadius` 是圆点本身的大小（格）。
 */
function drawMarker(
  context: CanvasRenderingContext2D,
  grid: OctoMapPgmGrid,
  cell: number,
  color: string,
  footprintRadius: number,
  dotRadius?: number,
): void {
  const { x, y } = cellCenter(grid, cell);
  const footprintCells = footprintRadius > 0 ? footprintRadius / grid.resolution : 0;
  const lineWidth = Math.max(0.8, Math.min(grid.width, grid.height) / 400);
  if (footprintCells > 0) {
    context.beginPath();
    context.arc(x, y, footprintCells, 0, Math.PI * 2);
    context.fillStyle = 'rgba(22, 163, 74, 0.18)';
    context.fill();
  }
  context.beginPath();
  const radius = Math.max(
    1.5,
    dotRadius ?? Math.min(grid.width, grid.height) / 120,
  );
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  context.strokeStyle = '#ffffff';
  context.lineWidth = lineWidth;
  context.stroke();
  // 足迹圈放在圆点之后描边：圆点比足迹大时（大图、起点大小调大）那一圈也还看得见。
  if (footprintCells > 0) {
    context.beginPath();
    context.arc(x, y, footprintCells, 0, Math.PI * 2);
    context.strokeStyle = 'rgba(22, 163, 74, 0.9)';
    context.lineWidth = lineWidth;
    context.stroke();
  }
}

/** 走不通时，在卡住的格上画一个红叉（白色描边垫底）。 */
function drawStuckCross(
  context: CanvasRenderingContext2D,
  grid: OctoMapPgmGrid,
  cell: number,
): void {
  const { x, y } = cellCenter(grid, cell);
  const radius = Math.max(3, Math.min(grid.width, grid.height) / 90);
  const stroke = (): void => {
    context.beginPath();
    context.moveTo(x - radius, y - radius);
    context.lineTo(x + radius, y + radius);
    context.moveTo(x + radius, y - radius);
    context.lineTo(x - radius, y + radius);
    context.stroke();
  };
  context.save();
  context.lineCap = 'round';
  context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  context.lineWidth = Math.max(2.4, Math.min(grid.width, grid.height) / 100);
  stroke();
  context.strokeStyle = '#dc2626';
  context.lineWidth = Math.max(1.2, Math.min(grid.width, grid.height) / 220);
  stroke();
  context.restore();
}
