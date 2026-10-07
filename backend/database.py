from sqlalchemy import create_engine, MetaData
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import StaticPool
import os
from typing import Generator

# 数据库配置
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./competitions.db")

# 创建数据库引擎
engine = create_engine(
    DATABASE_URL,
    poolclass=StaticPool,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {}
)

# 创建会话工厂
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# 创建基础的SQLAlchemy模型类
Base = declarative_base()

# 会话依赖
def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# 初始化数据库
def init_db():
    """创建数据库表"""
    from models.competition import Competition, CrawlTask, CrawlSchedule, DataSource
    print("正在创建数据库表...")
    Base.metadata.create_all(bind=engine)
    print("数据库表创建完成！")
    
    # 添加初始数据源
    if DATABASE_URL.__contains__("sqlite"):
        db = SessionLocal()
        try:
            # 检查是否已存在数据源
            existing = db.query(DataSource).filter(DataSource.name.in_([
                "教育部", "创新大赛", "竞赛管家"
            ])).all()
            
            if not existing:
                # 添加默认数据源
                sources = [
                    DataSource(
                        name="教育部",
                        platform="教育部",
                        baseUrl="https://www.moe.gov.cn",
                        description="教育部官方网站，发布各类教育竞赛信息",
                        crawlType="list"
                    ),
                    DataSource(
                        name="创新大赛",
                        platform="创新大赛",
                        baseUrl="https://www.innofair.com.cn",
                        description="全国青少年科技创新大赛官方网站",
                        crawlType="list"
                    ),
                    DataSource(
                        name="竞赛管家",
                        platform="竞赛管家",
                        baseUrl="https://www.saomeng.com",
                        description="综合竞赛信息聚合平台",
                        crawlType="list"
                    )
                ]
                
                db.add_all(sources)
                db.commit()
                print(f"已添加 {len(sources)} 个初始数据源")
            else:
                print("初始数据源已存在")
                
        finally:
            db.close()

# 关闭数据库连接
def close_db():
    """关闭所有数据库连接"""
    engine.dispose()
    print("数据库连接已关闭")