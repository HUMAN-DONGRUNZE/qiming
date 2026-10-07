from sqlalchemy import Column, Integer, String, DateTime, Text, Boolean, Float, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from datetime import datetime

Base = declarative_base()

class Competition(Base):
    __tablename__ = "competitions"
    
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(500), nullable=False, index=True)
    category = Column(String(100), nullable=False, index=True)
    status = Column(String(50), nullable=False, default="招募中")
    description = Column(Text, nullable=True)
    details = Column(Text, nullable=True)
    
    # 时间相关
    startDate = Column(DateTime, nullable=False, index=True)
    endDate = Column(DateTime, nullable=False, index=True)
    registrationStartDate = Column(DateTime, nullable=False)
    registrationEndDate = Column(DateTime, nullable=False)
    createdAt = Column(DateTime, default=datetime.utcnow, index=True)
    updatedAt = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # 地点信息
    location = Column(String(200), nullable=False)
    
    # 费用信息
    registrationFee = Column(String(100), nullable=True, default="免费")
    
    # 组织信息
    organizer = Column(String(200), nullable=True)
    guidingOrganization = Column(String(200), nullable=True)
    
    # 报名信息
    registrationMethod = Column(Text, nullable=True)
    participants = Column(Integer, default=0, index=True)
    
    # 爬虫信息
    dataSource = Column(String(100), nullable=True)  # 数据来源平台
    originalUrl = Column(String(500), nullable=True)  # 原始URL
    isCrawled = Column(Boolean, default=False, index=True)
    
    # 标签
    tags = Column(Text, nullable=True)  # JSON格式的标签
    
    # 状态标记
    isVisible = Column(Boolean, default=True)
    isHot = Column(Boolean, default=False)
    
    # 评分和统计
    viewCount = Column(Integer, default=0)
    rating = Column(Float, default=0.0)
    
    def __repr__(self):
        return f"<Competition(id={self.id}, title='{self.title}', status='{self.status}')>"

class CrawlTask(Base):
    __tablename__ = "crawl_tasks"
    
    id = Column(Integer, primary_key=True, index=True)
    platform = Column(String(100), nullable=False)  # 爬取的平台名称
    url = Column(String(1000), nullable=False)      # 爬取的目标URL
    status = Column(String(50), default="pending") # pending, running, completed, failed
    
    # 任务信息
    startTime = Column(DateTime, nullable=True)
    endTime = Column(DateTime, nullable=True)
    duration = Column(Float, nullable=True)         # 执行时间(秒)
    
    # 统计信息
    processedCount = Column(Integer, default=0)   # 处理的记录数
    successCount = Column(Integer, default=0)     # 成功的记录数
    errorCount = Column(Integer, default=0)       # 错误的记录数
    
    # 详细信息
    errorMessage = Column(Text, nullable=True)
    logInfo = Column(Text, nullable=True)           # JSON格式的日志信息
    
    # 时间戳
    createdAt = Column(DateTime, default=datetime.utcnow)
    scheduledAt = Column(DateTime, nullable=True)   # 计划执行时间
    
    def __repr__(self):
        return f"<CrawlTask(id={self.id}, platform='{self.platform}', status='{self.status}')>"

class CrawlSchedule(Base):
    __tablename__ = "crawl_schedules"
    
    id = Column(Integer, primary_key=True, index=True)
    platform = Column(String(100), nullable=False)
    cronExpression = Column(String(100), nullable=False)  # cron表达式
    enabled = Column(Boolean, default=True)
    
    # 配置信息
    maxConcurrency = Column(Integer, default=3)          # 最大并发数
    timeout = Column(Integer, default=300)             # 超时时间(秒)
    
    # 状态信息
    lastRunAt = Column(DateTime, nullable=True)
    nextRunAt = Column(DateTime, nullable=True)
    
    # 创建和更新时间
    createdAt = Column(DateTime, default=datetime.utcnow)
    updatedAt = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    def __repr__(self):
        return f"<CrawlSchedule(id={self.id}, platform='{self.platform}', enabled={self.enabled})>"

class DataSource(Base):
    __tablename__ = "data_sources"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False, unique=True)
    platform = Column(String(100), nullable=False)  # 如: 教育部, 创新大赛
    baseUrl = Column(String(500), nullable=False)
    description = Column(Text, nullable=True)
    
    # 爬虫配置
    crawlType = Column(String(50), default="list")   # list, detail, custom
    xpathConfig = Column(Text, nullable=True)       # JSON格式的XPath配置
    apiConfig = Column(Text, nullable=True)          # JSON格式的API配置
    
    # 状态
    isActive = Column(Boolean, default=True)
    lastCrawledAt = Column(DateTime, nullable=True)
    
    # 统计
    totalCrawled = Column(Integer, default=0)
    successRate = Column(Float, default=0.0)
    
    createdAt = Column(DateTime, default=datetime.utcnow)
    updatedAt = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    def __repr__(self):
        return f"<DataSource(id={self.id}, name='{self.name}', platform='{self.platform}')>"
