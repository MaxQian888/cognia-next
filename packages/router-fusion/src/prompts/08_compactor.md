# Context Compactor · context-1

前置：通用约束。输入槽：authoritative_task_state、transcript、artifact_index；输出由实现定义的HandoffState。
保留目标、所有硬约束、已确认决策、当前revision、未完成事项、证据引用、尚存风险和未解决问题。
删除重复聊天与无关探索细节，但不能删除不利的失败证据、需求变化或安全约束。
区分历史版本与当前版本，不把过去测试通过写成现在通过。
不能编造被省略部分内容；上下文无法压缩到限制内时明确报告，不能静默丢关键要求。
HandoffState中的硬约束与版本最终由程序从权威TaskState注入和核对。
