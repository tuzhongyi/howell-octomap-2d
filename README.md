# howell-octomap-2d

OctoMap 二维寻路组件（基于 PGM 占用图），作为 Angular 组件库供其他项目引用。

## 安装

构建产物放在 `release` 分支上，其他项目通过 GitHub 安装：

```bash
npm install github:tuzhongyi/howell-octomap-2d#release
```

peerDependencies 需要宿主自己安装：

- `@angular/core` ^21.0.0

## 使用

```ts
import { OctoMapPgmComponent, OctoMapProjection, decodePgm } from 'howell-octomap-2d';
```

组件选择器：`app-octo-map-pgm`。`image` 输入是一张已解码的灰度图（用 `decodePgm` 把 PGM 文件转成 `OctoMapProjection`），`resolution` 指定一格多少米。

## 开发

```bash
npm install
npm run build    # 产物输出到 dist/
```

## 发布

1. 修改 `package.json` 里的 `version`
2. `npm run build`
3. 把 `dist/` 的内容提交到 `release` 分支并推送

`release` 分支只放构建产物，不要在上面直接开发；源码以 `main` 为准。
