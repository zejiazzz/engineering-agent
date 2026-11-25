# Web 前端设计规范

既有项目的设计稿、主题、品牌、组件及明确覆盖优先。本规范提供共用基线，包括移动端布局尺寸、控件、主题、图标和样式组织。按目标项目技术栈和实际设计验证。

## 设计基准

- 移动稿基准宽度为 375px。页面优先用百分比和 Flex 分配可用空间，固定间距、控件与字号按设计使用 px。
- 页面根节点继承应用壳的可用高度。使用 Flex 的路由页面用 `flex: 1; min-height: 0`，内部滚动区占剩余空间；独立页继承应用根高度。
- 挂载于应用壳之外的临时全屏层同步应用有效宽度和纵向定位。需要视口单位时优先动态视口，按目标浏览器提供兜底。
- 安全区按目标宿主和沉浸式设计处理。需要底部安全区时同时核对栏高度与底部内边距。

### 页面尺寸与单位选择

| 场景                                     | 规则                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| 页面、内容区、按钮等需要铺满父容器的宽度 | 优先 `width: 100%`；按比例分配的区域使用百分比，剩余空间使用 Flex                   |
| 页面左右边距                             | `padding-left/right`、`margin-left/right` 使用 `px`，不随视口等比放大               |
| 上下间距、模块间距                       | `padding-top/bottom`、`margin-top/bottom`、`gap` 使用 `px`                          |
| 字号与行高                               | 字号使用固定 `px`；行高使用无单位比例或固定 `px`，避免跟随根字号缩放                |
| iconfont 图标及点击容器                  | 图标 `font-size`、固定点击容器宽高使用 `px`                                         |
| 页面头部、底部栏高度                     | 使用固定 `px`，配合 `flex-shrink: 0`；不使用 rem、百分比或视口单位缩放高度          |
| 固定尺寸的控件、图标、边框、圆角         | 使用 `px`，保持明确的视觉尺寸                                                       |
| 确实需要随全局比例缩放的局部视觉元素     | 可按需使用 `rem`；页面边距、模块间距、字号、iconfont 和头底栏高度仍遵守上述 px 规则 |
| 图片、视频比例                           | 使用 `aspect-ratio` 配合容器宽度，避免把宽高都写死                                  |

百分比以包含块为参照。页面已经位于应用根容器中，铺满页面时使用 `100%`，不要用 `100vw` 绕过大屏容器宽度限制。有固定间距的等分布局优先使用 Flex 和 px `gap`，避免百分比宽度相加后再叠加间距造成溢出。高度继续遵守父级可用高度约束，不机械地将所有高度改为百分比。

## 色彩、按钮与选择状态

- 共用浅色主操作使用 `#111113` 底色与白字，深色主题确认使用 `linear-gradient(90deg, #00ff63, #00ffc2)` 和 `#191919` 字色。禁用态使用明确降级的背景或 `opacity: 0.4`。项目有设计 token 时沿用项目约定。
- 主按钮默认宽度铺满容器，高度 48–64px，字号 16px、字重 600、圆角 8–24px，默认无边框，具体高度和圆角取设计。次按钮按设计选择浅灰底 `#f5f6fa` 配 `#63666d`，白底配 `#191919` 边线及字色，或透明底配 `#787d85`。
- 居中弹窗的关闭控件优先复用共享组件。共用视觉是 24×24px、圆形 `#e6e9ef` 背景、居中的 12px `#191919` 叉号。关闭和清除按钮按动作提供可访问名称。
- 行内复选采用 16×16px 且使用 `object-fit: contain` 的选中与未选图标。卡片选择复用既有组件，区分选中、部分选中和未选；默认右上间距 4px，可点的 20×20px 控件内显示 18×18px 图标，纯展示使用 20×20px 图标。自定义外观同时保留键盘及辅助技术可识别的操作与状态。

## 布局规范

页面头部和底部栏的设计高度使用 `px`，并设置 `flex-shrink: 0`，中间内容区用 Flex 占据剩余空间。下面的 `44px`、`72px` 仅为结构示例，具体数值以页面设计为准。需要底部安全区时，在 px 基础高度和底部内边距上同步叠加 `env(safe-area-inset-bottom)`。

```less
// 页面标准结构
.page {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  height: 44px;
  padding: 0 16px;
}
.content {
  flex: 1;
  min-height: 0;
  padding: 16px;
  overflow-y: auto;
}
.bottomBar {
  flex-shrink: 0;
  height: 72px;
  padding: 12px 16px;
}

// 仅用于不经过 Layout 的独立顶层页面
.standalonePage {
  min-height: 100%;
}

// 底部弹出式（Sheet）
.sheetBody {
  overflow: hidden;
  border-radius: 12px 12px 0 0;
}
.dragBar {
  width: 33px;
  height: 4px;
  margin: 10px auto;
  border-radius: 2px;
}

// 居中弹窗（Dialog）
.dialogCard {
  width: 286px;
  padding: 24px 20px 20px;
  border-radius: 12px;
}

// 头部标题居中布局
// 左右两侧用 flex: 1 0 0 等分除去标题内容宽度后的剩余空间，
// 标题用 flex: 0 1 auto; min-width: 0 居中，长文本自动截断省略。
// 要点：左右 group 不设 min-width: 0，保持自身内容最小宽度，
// 长标题会被 flex 自然压缩触发 text-overflow: ellipsis。
.headerCenter {
  display: flex;
  align-items: center;
}
.leftGroup,
.rightGroup {
  flex: 1 0 0;
  display: flex;
  align-items: center;
}
.leftGroup {
  justify-content: flex-start;
}
.rightGroup {
  justify-content: flex-end;
}
.title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-align: center;
  text-overflow: ellipsis;
}
```

## 滚动条与图标

- 滚动条的共用视觉为 3px 宽高、3px 圆角、透明轨道。浅色滑块 `#00000026`，悬停 `#00000040`；深色滑块 `#ffffff40`，悬停 `#fff6`。隐藏两端箭头，标准回退使用 `thin`。外观调整保留原滚动行为、分页与既有隐藏条件。
- 字体图标以显式 px 字号和颜色控制，点击容器保持固定尺寸。容器用 Flex 居中图标。优先复用项目的语义图标和资源映射，装饰图标由外层控件提供可访问名称。
- 视频播放共用视觉为 52×52px 圆形容器，`#0000004d` 半透明背景与 18.6px 背景模糊，内部图标 24px。

## 样式与类名

- 局部样式归所属组件，使用项目现有的隔离机制。采用 Less 与 CSS Modules 的项目使用同名 `.module.less`，CSS Modules 引用按项目命名规则。全局样式维护 reset、变量、工具类和第三方覆盖。
- CSS 属性顺序从已启用的 Stylelint 配置读取。项目采用 `stylelint-config-rational-order` 时遵守其顺序。
- 共用样式可使用与设计一致的 hex 色值；项目已经定义并使用设计 token 时复用该体系。

### 类名组合

- 组合两个及以上类名（含固定类名、条件类名和外部传入的 `className`）使用项目现有的类名组合工具，采用 `classnames` 的项目沿用该包；单个类名直接使用 `className={Style.item}`。
- 禁止使用模板字符串、字符串加法、数组 `join(' ')` 手动拼接多类名；禁止用三元表达式返回类名或空字符串来参与拼接。
- 条件类名使用对象形式；复杂业务条件先提取为有语义的布尔常量，再作为对象的值，条件含义与注释要求遵循前端编码规范。

```tsx
import classNames from "classnames";

// 图片创作条目使用专属布局。
<div
  className={classNames(Style.item, {
    [Style.pictureCreateItem]: isPictureCreate,
  })}
/>;
```
