// 让 screenX/screenY 随 client 坐标变化，避免固定常量被判定为自动化。
// 旧实现把原型属性写成固定 value，所有鼠标事件坐标相同，反而更像机器人。
(function () {
    try {
        const sx = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenX');
        const sy = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenY');
        if (sx && sx.get && sx.configurable !== false) {
            // 已有原生 getter 时无需覆盖
            return;
        }
    } catch (e) {}

    const offsetX = Math.floor(Math.random() * 100) + 40;
    const offsetY = Math.floor(Math.random() * 80) + 80;

    try {
        Object.defineProperty(MouseEvent.prototype, 'screenX', {
            get: function () {
                return (this.clientX || 0) + (window.screenX || 0) + offsetX;
            },
            configurable: true,
        });
        Object.defineProperty(MouseEvent.prototype, 'screenY', {
            get: function () {
                return (this.clientY || 0) + (window.screenY || 0) + offsetY;
            },
            configurable: true,
        });
    } catch (e) {}
})();