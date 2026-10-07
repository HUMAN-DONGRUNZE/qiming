from pydantic import BaseModel, Field, HttpUrl
from typing import List, Optional
from datetime import datetime

# 赛事模式
class CompetitionBase(BaseModel):
    title: str = Field(..., min_length=1, max_length=500, description="赛事标题")
    category: str = Field(..., description="赛事分类")
    status: str = Field(default="招募中", description="赛事状态")
    description: Optional[str] = Field(None, description="赛事简介")
    details: Optional[str] = Field(None, description="赛事详情")
    startDate: datetime = Field(..., description="开始日期")
    endDate: datetime = Field(..., description="结束日期")
    registrationStartDate: datetime = Field(..., description="报名开始日期")
    registrationEndDate: datetime = Field(..., description="报名截止日期")
    location: str = Field(..., description="举办地点")
    registrationFee: str = Field(default="免费", description="报名费用")
    organizer: Optional[str] = Field(None, description="组织单位")
    guidingOrganization: Optional[str] = Field(None, description="指导单位")
    registrationMethod: Optional[str] = Field(None, description="报名方式")
    originalUrl: Optional[HttpUrl] = Field(None, description="原始链接")
    tags: Optional[str] = Field(None, description="标签(JSON格式)")
    isHot: bool = Field(default=False, description="是否为热门赛事")

class CompetitionCreate(CompetitionBase):
    pass

class CompetitionUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=500)
    category: Optional[str] = None
    status: Optional[str] = None
    description: Optional[str] = None
    details: Optional[str] = None
    startDate: Optional[datetime] = None
    endDate: Optional[datetime] = None
    registrationStartDate: Optional[datetime] = None
    registrationEndDate: Optional[datetime] = None
    location: Optional[str] = None
    registrationFee: Optional[str] = None
    organizer: Optional[str] = None
    guidingOrganization: Optional[str] = None
    registrationMethod: Optional[str] = None
    originalUrl: Optional[HttpUrl] = None
    tags: Optional[str] = None
    isHot: Optional[bool] = None
    isVisible: Optional[bool] = None
    rating: Optional[float] = Field(None, ge=0.0, le=5.0)

class CompetitionResponse(CompetitionBase):
    id: int
    participants: int = Field(default=0)
    dataSource: Optional[str] = None
    isCrawled: bool = Field(default=False)
    viewCount: int = Field(default=0)
    rating: float = Field(default=0.0)
    isVisible: bool = Field(default=True)
    createdAt: datetime
    updatedAt: datetime

    class Config:
        from_attributes = True

# 分页响应
class PaginationResponse(BaseModel):
    items: List[CompetitionResponse]
    total: int
    page: int
    size: int
    totalPages: int

# 爬虫模式
class CrawlTaskCreate(BaseModel):
    platform: str = Field(..., description="爬取平台")
    url: str = Field(..., description="爬取URL")
    scheduledAt: Optional[datetime] = Field(None, description="计划执行时间")

class CrawlTaskResponse(BaseModel):
    id: int
    platform: str
    url: str
    status: str
    startTime: Optional[datetime]
    endTime: Optional[datetime]
    duration: Optional[float]
    processedCount: int = Field(default=0)
    successCount: int = Field(default=0)
    errorCount: int = Field(default=0)
    errorMessage: Optional[str]
    logInfo: Optional[str]
    createdAt: datetime
    scheduledAt: Optional[datetime]

    class Config:
        from_attributes = True

class CrawlTaskUpdate(BaseModel):
    status: Optional[str] = None
    startTime: Optional[datetime] = None
    endTime: Optional[datetime] = None
    duration: Optional[float] = None
    processedCount: Optional[int] = None
    successCount: Optional[int] = None
    errorCount: Optional[int] = None
    errorMessage: Optional[str] = None
    logInfo: Optional[str] = None

# 爬虫配置模式
class CrawlScheduleCreate(BaseModel):
    platform: str = Field(..., description="平台名称")
    cronExpression: str = Field(..., description="Cron表达式")
    enabled: bool = Field(default=True)
    maxConcurrency: int = Field(default=3, ge=1, le=10)
    timeout: int = Field(default=300, ge=60, le=3600)

class CrawlScheduleResponse(BaseModel):
    id: int
    platform: str
    cronExpression: str
    enabled: bool
    maxConcurrency: int
    timeout: int
    lastRunAt: Optional[datetime]
    nextRunAt: Optional[datetime]
    createdAt: datetime
    updatedAt: datetime

    class Config:
        from_attributes = True

# 数据源模式
class DataSourceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    platform: str = Field(..., description="平台标识")
    baseUrl: str
    description: Optional[str] = None
    crawlType: str = Field(default="list", pattern="^(list|detail|custom)$")
    xpathConfig: Optional[str] = None
    apiConfig: Optional[str] = None

class DataSourceResponse(BaseModel):
    id: int
    name: str
    platform: str
    baseUrl: str
    description: Optional[str]
    crawlType: str
    xpathConfig: Optional[str]
    apiConfig: Optional[str]
    isActive: bool
    lastCrawledAt: Optional[datetime]
    totalCrawled: int
    successRate: float
    createdAt: datetime
    updatedAt: datetime

    class Config:
        from_attributes = True

# 搜索和筛选模式
class CompetitionSearch(BaseModel):
    search: Optional[str] = Field(None, description="搜索关键词")
    category: Optional[int] = Field(None, description="分类ID")
    status: Optional[str] = Field(None, description="状态筛选")
    region: Optional[str] = Field(None, description="地区筛选")
    startDate: Optional[datetime] = Field(None, description="开始日期")
    endDate: Optional[datetime] = Field(None, description="结束日期")
    page: int = Field(default=1, ge=1)
    size: int = Field(default=10, ge=1, le=100)

# 响应信息模式
class ResponseMessage(BaseModel):
    message: str
    success: bool

class StatsResponse(BaseModel):
    total: int
    categorized: int
    platforms: int
    updates: int