import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  computed,
  effect,
  signal,
  viewChild,
} from '@angular/core';
import { OctomapProjection } from '../utils/pgm.util';
import {
  OCTOMAP_PGM_DEFAULT_DOG_RADIUS,
  OCTOMAP_PGM_DEFAULT_GOAL_RADIUS,
  OCTOMAP_PGM_DEFAULT_RESOLUTION,
  OctomapPgmGrid,
  OctomapPgmMode,
  OctomapPgmPath,
  OctomapPgmPlan,
  OctomapPgmViewState,
} from './octomap-2d-pgm.model';
import { buildPgmGrid, pgmCellToWorld, planPgmPath } from './octomap-2d-pgm-grid';

/**
 * 在一张 PGM 地图上做二维寻路。
 *
 * 输入是一张已经解码好的灰度图 {@link OctomapProjection}，加一格多少米。建图、膨胀、
 * A*、拉直全在这个目录里，不碰 Three.js、不碰 octomap 的三维控制器；宿主只负责
 * 把文件读成像素。这样同一份算法既能给 `/system/pgm` 的二维页用，也能在测试里直接
 * `new` 一个网格跑。
 *
 * 与三维寻路共用的是**小狗的形状**：`dogRadius` 决定障碍外扩多少，`goalRadius`
 * 决定终点歪了之后最多吸附多远。二维平面里没有高度与天花板，`maxStepHeight` /
 * `dogHeight` 不参与判定。
 *
 * 交互：左键设起点、右键设终点；**宿主调用 {@link runSearch} 才计算**。组件本身不画
 * 工具条或设置面板——那些在宿主里（test 的 `d2-settings`）。组件只负责画布、交互、
 * 建图与寻路，并通过 {@link viewState} 暴露只读状态给宿主显示。参数改过就把旧结果
 * 清掉，让用户知道该再点一次。走不通时不只是报错：A* 记下能走到的最远处，画布会标出
 * 卡在哪一格。
 */
@Component({
  selector: 'howell-octomap-2d-pgm',
  imports: [],
  templateUrl: './octomap-2d-pgm.component.html',
  styleUrl: './octomap-2d-pgm.component.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Octomap2dPgmComponent implements OnChanges, OnDestroy {
  /** 要寻路的 PGM 图像；为空时只显示一句提示。 */
  @Input() image: OctomapProjection | null = null;

  /** 一格对应多少米。PGM 文件头不带比例尺，只能由宿主给。 */
  @Input() resolution: number = OCTOMAP_PGM_DEFAULT_RESOLUTION;

  /** 小狗碰撞半径（米），决定障碍往外膨胀多少。 */
  @Input() dogRadius: number = OCTOMAP_PGM_DEFAULT_DOG_RADIUS;

  /** 终点范围（米）：点中的格子不可通行时，最多吸附这么远。 */
  @Input() goalRadius: number = OCTOMAP_PGM_DEFAULT_GOAL_RADIUS;

  /**
   * 通行口径。由宿主拥有；父组件改这个输入会重建网格。
   *
   * 默认「黑格可走」，与本仓导出的 PGM 对齐：那里的黑 = 该列有点，正是小狗要走的
   * 地面；从 map-server 换来、墙画成黑色的地图在宿主里切到「白格可走」即可。
   */
  @Input() mode: OctomapPgmMode = 'occupiedWalkable';

  /** 起点圆点半径（格）。null 表示按地图短边自动取值。 */
  @Input() markerSize: number | null = null;

  /** 起点吸附范围（米）：点中的起点不可走时，最多找这么远。 */
  @Input() startSnapRadius: number = OCTOMAP_PGM_DEFAULT_GOAL_RADIUS;

  /**
   * 起点要求的最小净空（米）。比建图时的碰撞半径更严时，起点会被推到离障碍更远的
   * 格子上；小于等于 `dogRadius` 时不生效（路线本身仍按碰撞半径膨胀）。
   */
  @Input() startClearance: number = OCTOMAP_PGM_DEFAULT_DOG_RADIUS;

  /** 是否允许拖动平移。关掉后单击仍可设起点/终点，拖动不会移动画布。 */
  @Input() allowPan = true;

  /** 是否允许滚轮缩放。关掉后滚轮交给页面滚动。 */
  @Input() allowZoom = true;

  /** 视口背景色；默认透明，宿主的背景会透出来。 */
  @Input() backgroundColor = 'transparent';

  /** 起点标记图片（URL / data URL）；为空或加载失败时用默认绿色圆点。 */
  @Input() startImage: string | null = null;

  /** 终点标记图片；为空或加载失败时用默认橙色圆点。 */
  @Input() goalImage: string | null = null;

  /** 每次「开始寻址」或清除时发出，供宿主显示或转交。 */
  @Output() readonly pathChange = new EventEmitter<OctomapPgmPlan | null>();

  /** 寻路完成时发出世界坐标路径；清除或走不通时发出 null。 */
  @Output() readonly pathComputed = new EventEmitter<OctomapPgmPath | null>();

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly viewportRef = viewChild<ElementRef<HTMLDivElement>>('viewport');

  /** 当前网格；`image` 为空、分辨率无效或建图失败时为空。 */
  protected readonly grid = signal<OctomapPgmGrid | null>(null);

  /** 用户点中的起点 / 终点格（吸附前的原始格）。 */
  private readonly startCell = signal<number | null>(null);
  private readonly goalCell = signal<number | null>(null);

  /** 最近一次「开始寻址」的结果；null 表示还没算，或端点 / 参数已经改过。 */
  protected readonly plan = signal<OctomapPgmPlan | null>(null);

  /** 设置输入的状态镜像；用信号驱动重绘与对外快照。 */
  private readonly markerSizeState = signal<number | null>(null);
  private readonly startSnapState = signal(OCTOMAP_PGM_DEFAULT_GOAL_RADIUS);
  private readonly startClearanceState = signal(OCTOMAP_PGM_DEFAULT_DOG_RADIUS);

  /** 只影响显示的缩放与平移，不参与建图/寻路。 */
  private readonly scale = signal(1);
  private readonly translateX = signal(0);
  private readonly translateY = signal(0);

  protected readonly viewTransform = computed(
    () =>
      `translate(${this.translateX()}px, ${this.translateY()}px) scale(${this.scale()})`,
  );

  /** 正在按下的指针；超过阈值才算拖动，否则松开时是一次点击。 */
  private drag: {
    pointerId: number;
    button: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null = null;

  /** 外部标记图；加载成功后替换默认圆点。 */
  private startImageEl: HTMLImageElement | null = null;
  private goalImageEl: HTMLImageElement | null = null;
  private imageLoadToken = 0;

  constructor() {
    this.markerSizeState.set(this.markerSize);
    this.startSnapState.set(this.startSnapRadius);
    this.startClearanceState.set(this.startClearance);
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
    if (changes['mode'] || changes['dogRadius'] || changes['resolution']) {
      rebuild = true;
    }
    if (changes['goalRadius']) {
      // 终点范围参与规划，换了就得重算，旧结果不能留。
      this.clearPlan();
    }
    if (changes['startSnapRadius']) {
      this.startSnapState.set(this.startSnapRadius);
      this.clearPlan();
    }
    if (changes['startClearance']) {
      this.startClearanceState.set(this.startClearance);
      this.clearPlan();
    }
    if (changes['markerSize']) {
      this.markerSizeState.set(this.markerSize);
    }
    if (changes['startImage'] || changes['goalImage']) {
      this.loadMarkerImages();
    }
    if (rebuild) {
      this.rebuild();
    }
  }

  ngOnDestroy(): void {
    this.imageLoadToken++;
  }

  /**
   * 加载外部起点/终点图。
   *
   * 先清空旧图并立即重绘（回到默认形状），加载成功后再重绘；加载失败保持默认。
   * `token` 防住「换了图之后，上一张图才加载完」的竞态。
   */
  private loadMarkerImages(): void {
    const token = ++this.imageLoadToken;
    this.startImageEl = null;
    this.goalImageEl = null;
    this.draw();

    const load = (url: string | null, assign: (image: HTMLImageElement) => void): void => {
      if (!url) {
        return;
      }
      const image = new Image();
      image.onload = () => {
        if (token !== this.imageLoadToken) {
          return;
        }
        assign(image);
        this.draw();
      };
      image.onerror = () => {
        if (token !== this.imageLoadToken) {
          return;
        }
        // 加载失败就继续用默认形状。
        this.draw();
      };
      image.src = url;
    };

    load(this.startImage, (image) => {
      this.startImageEl = image;
    });
    load(this.goalImage, (image) => {
      this.goalImageEl = image;
    });
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
        return `起点附近 ${this.startSnapState().toFixed(2)} m 内没有${this.clearanceHint()}可通行的格子。`;
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

  /** 只读状态快照；宿主设置面板用。 */
  viewState(): OctomapPgmViewState {
    const grid = this.grid();
    return {
      grid: grid
        ? { width: grid.width, height: grid.height, resolution: grid.resolution }
        : null,
      startCell: this.startCell(),
      goalCell: this.goalCell(),
      plan: this.plan(),
      canSearch: this.canSearch(),
      gridInfo: this.gridInfo(),
      startText: this.startText(),
      goalText: this.goalText(),
      status: this.statusText(),
      markerSize: this.markerSizeState() ?? (grid ? autoMarkerSize(grid) : null),
    };
  }

  /** 用户按下「开始寻址」：这时才真的跑一次规划。 */
  runSearch(): void {
    const grid = this.grid();
    if (!grid) {
      return;
    }
    const plan = planPgmPath(
      grid,
      this.startCell(),
      this.goalCell(),
      this.goalRadius,
      this.startSnapState(),
      this.startClearanceState(),
    );
    this.plan.set(plan);
    this.pathChange.emit(plan);
    this.pathComputed.emit(plan.path);
  }

  clearMarks(): void {
    this.startCell.set(null);
    this.goalCell.set(null);
    this.clearPlan();
  }

  protected onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 && event.button !== 2) {
      return;
    }
    if (!this.grid()) {
      return;
    }
    this.drag = {
      pointerId: event.pointerId,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      lastX: this.translateX(),
      lastY: this.translateY(),
      moved: false,
    };
    const viewport = this.viewportRef()?.nativeElement;
    try {
      viewport?.setPointerCapture(event.pointerId);
    } catch {
      // 指针已经失效时忽略；后面的 pointermove 会照常走冒泡。
    }
    event.preventDefault();
  }

  protected onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > 3) {
      drag.moved = true;
    }
    if (!drag.moved || !this.allowPan) {
      // 拖动开关关掉时仍然记 moved：拖一下不会误落成一次点击。
      return;
    }
    this.translateX.set(drag.lastX + dx);
    this.translateY.set(drag.lastY + dy);
    event.preventDefault();
  }

  protected onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    this.drag = null;
    const viewport = this.viewportRef()?.nativeElement;
    if (viewport?.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
    // 拖动是平移，不落到起点/终点；只有没移动的单击才算点击。
    if (drag.moved) {
      return;
    }
    const grid = this.grid();
    if (!grid) {
      return;
    }
    const cell = this.cellFromEvent(event, grid);
    if (cell === null) {
      return;
    }
    if (drag.button === 2) {
      this.goalCell.set(cell);
    } else {
      this.startCell.set(cell);
    }
    // 端点换了，旧路线就作废；按钮仍在，用户想算再点一次。
    this.clearPlan();
  }

  protected onPointerCancel(event: PointerEvent): void {
    if (this.drag?.pointerId !== event.pointerId) {
      return;
    }
    this.drag = null;
  }

  protected onWheel(event: WheelEvent): void {
    if (!this.allowZoom || !this.grid()) {
      return;
    }
    event.preventDefault();
    const current = this.scale();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(20, Math.max(0.1, current * factor));
    if (next === current) {
      return;
    }
    const viewport = this.viewportRef()?.nativeElement;
    if (!viewport) {
      return;
    }
    // 以指针为锚点：缩放前后，指针下那一点保持在原地。
    const rect = viewport.getBoundingClientRect();
    const vx = event.clientX - rect.left;
    const vy = event.clientY - rect.top;
    const px = (vx - this.translateX()) / current;
    const py = (vy - this.translateY()) / current;
    this.scale.set(next);
    this.translateX.set(vx - px * next);
    this.translateY.set(vy - py * next);
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
      mode: this.mode,
      dogRadius: this.dogRadius,
      resolution: this.resolution,
    });
    this.grid.set(grid);
  }

  /** 清掉旧结果；没有结果时什么也不发。 */
  private clearPlan(): void {
    if (this.plan() === null) {
      return;
    }
    this.plan.set(null);
    this.pathChange.emit(null);
    this.pathComputed.emit(null);
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
    return this.startClearanceState() > this.dogRadius ? '满足起点净空的' : '';
  }

  /** 走不通时的一句话：最远到哪、还差多远、残段多长。 */
  private unreachableText(grid: OctomapPgmGrid, plan: OctomapPgmPlan): string {
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
  private cellFromEvent(event: PointerEvent, grid: OctomapPgmGrid): number | null {
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
    for (let i = 0; i < grid.base.length; i++) {
      const p = i * 4;
      const v = grid.base[i];
      // 底图保持 PGM 原始灰度：切通行口径只改「哪些格算障碍」，不再翻转黑白。
      let r = v;
      let g = v;
      let b = v;
      if (grid.rawBlocked[i] === 0 && grid.blocked[i] !== 0) {
        // 只因为碰撞半径而不可走的格子：叠一层半透明浅红，原图仍然透得出来。
        r = Math.round(v * 0.55 + 254 * 0.45);
        g = Math.round(v * 0.55 + 202 * 0.45);
        b = Math.round(v * 0.55 + 202 * 0.45);
      }
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
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
    const markerSize = this.markerSizeState() ?? autoMarkerSize(grid);
    if (start !== null) {
      const cell = plan?.startCell ?? start;
      if (this.startImageEl) {
        // 外部图替换绿色圆点，但碰撞足迹圈仍然画：那圈表示的是狗半径，不是标记。
        drawFootprint(context, grid, cell, this.startClearanceState());
        drawMarkerImage(context, grid, cell, this.startImageEl, markerSize);
      } else {
        drawMarker(context, grid, cell, '#16a34a', this.startClearanceState(), markerSize);
      }
    }
    if (goal !== null) {
      const cell = plan?.goalCell ?? goal;
      if (this.goalImageEl) {
        drawMarkerImage(context, grid, cell, this.goalImageEl, markerSize);
      } else {
        drawMarker(context, grid, cell, '#f59e0b', 0);
      }
    }

    if (plan && plan.stuckCell !== null) {
      drawStuckCross(context, grid, plan.stuckCell);
    }
  }
}

/** 「起点大小」的自动值：短边的 1/120，与原来固定圆点的观感一致。 */
function autoMarkerSize(grid: OctomapPgmGrid): number {
  return Math.max(1, Math.round(Math.min(grid.width, grid.height) / 120));
}

/** 格索引序列 → 画布上的格心坐标（1 格 = 1 像素）。 */
function cellPoints(
  grid: OctomapPgmGrid,
  cells: readonly number[],
): { x: number; y: number }[] {
  return cells.map((cell) => cellCenter(grid, cell));
}

function cellCenter(grid: OctomapPgmGrid, cell: number): { x: number; y: number } {
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

/** 起点碰撞足迹：只画圈，不画圆点（外部图片标记用它垫底）。 */
function drawFootprint(
  context: CanvasRenderingContext2D,
  grid: OctomapPgmGrid,
  cell: number,
  footprintRadius: number,
): void {
  if (!(footprintRadius > 0)) {
    return;
  }
  const { x, y } = cellCenter(grid, cell);
  const radius = footprintRadius / grid.resolution;
  const lineWidth = Math.max(0.8, Math.min(grid.width, grid.height) / 400);
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = 'rgba(22, 163, 74, 0.18)';
  context.fill();
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.strokeStyle = 'rgba(22, 163, 74, 0.9)';
  context.lineWidth = lineWidth;
  context.stroke();
}

/** 把外部标记图按最大边 `size` 格等比居中画在格心上。 */
function drawMarkerImage(
  context: CanvasRenderingContext2D,
  grid: OctomapPgmGrid,
  cell: number,
  image: HTMLImageElement,
  size: number,
): void {
  const { x, y } = cellCenter(grid, cell);
  const max = Math.max(1, size);
  const ratio =
    image.naturalWidth > 0 && image.naturalHeight > 0
      ? image.naturalWidth / image.naturalHeight
      : 1;
  const width = ratio >= 1 ? max : max * ratio;
  const height = ratio >= 1 ? max / ratio : max;
  context.drawImage(image, x - width / 2, y - height / 2, width, height);
}

/**
 * 端点标记。`footprintRadius` > 0 时额外画一圈碰撞足迹：起点那一圈就是小狗在二维
 * 图上占的地方，用户调「起点碰撞」时它跟着变。`dotRadius` 是圆点本身的大小（格）。
 */
function drawMarker(
  context: CanvasRenderingContext2D,
  grid: OctomapPgmGrid,
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
  grid: OctomapPgmGrid,
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
