/**
 * 俯视地图的 PGM 编解码器：写出的是二进制 (P5)，读入兼容 P2 / P5，灰度使用
 * map-server 惯用的 0（占用）/ 254（空闲）两档。
 */

/** 单通道的俯视地图图像（兼容 PGM）。 */
export interface OctomapProjection {
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
export const PGM_OCCUPIED = 0;
/** 白色——点云的该列为空。 */
export const PGM_FREE = 254;

/**
 * 灰度不高于这个值的像素算「黑」。
 *
 * 编码器只写 0 / 254，所以这个阈值在本仓的图上不会产生歧义；放宽到 127 是为了
 * 接住别处导出的地图（map-server 里还有 205 的未知格，它落在「不黑」的一侧）。
 */
export const PGM_DARK_MAX = 127;

/**
 * 灰度不低于这个值的像素算「白」——空闲。
 *
 * 与 {@link PGM_DARK_MAX} 之间留出的中间档是「未知」（map-server 写 205）。标准
 * occupancy 图不建议把未知当空闲，所以「白格可走」只认真正的白，中间档照样是障碍。
 */
export const PGM_FREE_MIN = 250;

/**
 * 把投影序列化为二进制 (P5) PGM 文件。
 *
 * `resolution` 可省略；给了就写进注释行，读回来时可以自动恢复比例尺。PGM 标准
 * 没有这个字段，但注释行允许任意内容，看图的软件会忽略它。
 */
export function encodePgm(
  projection: OctomapProjection,
  resolution?: number,
): Uint8Array<ArrayBuffer> {
  const scaleText =
    resolution !== undefined && resolution > 0 ? ` resolution=${resolution} m/cell` : '';
  const header = new TextEncoder().encode(
    `P5\n# octomap top-down projection (0=occupied, 254=free)${scaleText}\n` +
      `${projection.width} ${projection.height}\n255\n`,
  );
  const out = new Uint8Array(new ArrayBuffer(header.length + projection.data.length));
  out.set(header, 0);
  out.set(projection.data, header.length);
  return out;
}

/**
 * 读入 PGM 文件（P2 文本 / P5 二进制），灰度统一归一化到 0..255。
 *
 * 只认 PGM 自己的头：宽、高、最大灰度。标准头里没有比例尺（map-server 把它放在
 * 同名 YAML 里）；本仓导出时把 `resolution=` 写进了注释行，读到就放进结果的
 * {@link OctomapProjection.resolution}，读不到就留给宿主另给。
 */
export function decodePgm(buffer: ArrayBuffer): OctomapProjection {
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  /** 头部的注释行；本仓的编码器会把比例尺写在这里。 */
  const comments: string[] = [];
  const decoder = new TextDecoder();

  const isSpace = (byte: number): boolean =>
    byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

  /** 跳过空白与 `#` 注释，停在第一个有效字节上。 */
  const skipBlank = (): void => {
    while (offset < bytes.length) {
      const byte = bytes[offset];
      if (byte === 0x23) {
        offset++;
        const start = offset;
        while (offset < bytes.length && bytes[offset] !== 0x0a) {
          offset++;
        }
        comments.push(decoder.decode(bytes.subarray(start, offset)).trim());
      } else if (isSpace(byte)) {
        offset++;
      } else {
        return;
      }
    }
  };

  const readToken = (): string => {
    skipBlank();
    const start = offset;
    while (offset < bytes.length && !isSpace(bytes[offset]) && bytes[offset] !== 0x23) {
      offset++;
    }
    return decoder.decode(bytes.subarray(start, offset));
  };

  const magic = readToken();
  if (magic !== 'P2' && magic !== 'P5') {
    throw new Error(`不是 PGM 文件（文件头是「${magic || '空'}」，应为 P2 或 P5）`);
  }
  const width = Number(readToken());
  const height = Number(readToken());
  const maxval = Number(readToken());
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`PGM 尺寸无效：${width} × ${height}`);
  }
  if (!Number.isInteger(maxval) || maxval <= 0 || maxval > 65535) {
    throw new Error(`PGM 最大灰度无效：${maxval}`);
  }

  const count = width * height;
  const data = new Uint8Array(count);
  const result: OctomapProjection = { width, height, data };
  const resolution = readResolution(comments);
  if (resolution !== undefined) {
    result.resolution = resolution;
  }

  if (magic === 'P2') {
    for (let i = 0; i < count; i++) {
      const token = readToken();
      const value = Number(token);
      if (token === '' || !Number.isFinite(value)) {
        throw new Error(`PGM 数据不足：只读到 ${i} / ${count} 个像素`);
      }
      data[i] = normalizeSample(value, maxval);
    }
    return result;
  }

  // P5：头之后恰好一个空白字符，随后就是原始像素。不能多跳空白——0x20 / 0x0a
  // 本身也是合法的灰度值。只有分隔符自己是 `\r`（CRLF 文件）时才连 `\n` 一起跳；
  // 判断依据必须是**分隔符**，不能看前两个像素字节，否则像素恰好是 13、10 时会被
  // 多吞掉一个。
  if (offset >= bytes.length) {
    throw new Error('PGM 缺少像素数据');
  }
  if (bytes[offset] === 0x0d) {
    offset++;
    if (bytes[offset] === 0x0a) {
      offset++;
    }
  } else {
    offset++;
  }

  const sampleBytes = maxval < 256 ? 1 : 2;
  const needed = count * sampleBytes;
  if (bytes.length - offset < needed) {
    throw new Error(`PGM 数据不足：需要 ${needed} 字节，只有 ${bytes.length - offset}`);
  }
  if (sampleBytes === 1) {
    data.set(bytes.subarray(offset, offset + count));
  } else {
    for (let i = 0; i < count; i++) {
      const high = bytes[offset + i * 2];
      const low = bytes[offset + i * 2 + 1];
      data[i] = normalizeSample((high << 8) | low, maxval);
    }
  }
  return result;
}

/** 从注释行里找本仓写的 `resolution=0.4 m/cell`；没有就返回 undefined。 */
function readResolution(comments: readonly string[]): number | undefined {
  for (const comment of comments) {
    const match = /resolution\s*=\s*([0-9]*\.?[0-9]+)/i.exec(comment);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
  }
  return undefined;
}

/** 16 位或非 255 上限的灰度映射到 0..255。 */
function normalizeSample(value: number, maxval: number): number {
  if (maxval === 255) {
    return Math.max(0, Math.min(255, value));
  }
  return Math.max(0, Math.min(255, Math.round((value * 255) / maxval)));
}
