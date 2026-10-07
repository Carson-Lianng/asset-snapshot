/**
 * @app/domain —— 计算口径的唯一实现
 *
 * 这一层是 PRD 全部计算规则的唯一落点：前后端共享同一份代码，
 * 前端用于实时预览，服务端用于落库与权威计算，二者不存在实现漂移。
 *
 * 约束（《技术设计文档》§1.2）：
 *   - 纯函数 / 纯值对象，不引用数据库、HTTP、框架，可脱离运行时单测
 *   - 金额一律以 Money 值对象流转，函数签名不得出现 number 类型的金额
 *   - 零 npm 运行依赖
 */
export * from './money.ts';
export * from './types.ts';
export * from './trend.ts';
export * from './fx.ts';
export * from './networth.ts';
export * from './returns.ts';
export * from './compare.ts';
export * from './inventory.ts';
