# 专业猫 IP 标签图标设计

## 目标

将浏览器标签页当前使用的幼态猫图标替换为工作台侧栏正在使用的专业猫 IP，保持品牌视觉一致。

## 方案比较

1. **复用现有专业猫 PNG（采用）**：品牌完全一致，不新增生成资产，浏览器直接缩放显示。
2. 单独裁切头像制作 favicon：小尺寸辨识度可能更高，但会产生额外图片维护成本。
3. 使用纯色字母或线性图标：小尺寸最清晰，但不符合“使用现在的 IP”要求。

## 实现

- 将 `<link rel="icon">` 和 `<link rel="shortcut icon">` 都指向 `/static/jingyan-agent-cat-professional.png`。
- 增加版本查询参数，避免浏览器继续使用旧 favicon 缓存。
- 页面标题和侧栏品牌图片保持不变。

## 验证

- HTML 不再引用旧的 `jingyan-agent-cat-favicon.png` 和 `.ico`。
- 页面加载后标签图标请求指向专业猫 IP。
- JavaScript 和现有布局回归保持通过。
