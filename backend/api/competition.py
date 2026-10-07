from fastapi import APIRouter, Depends, HTTPException, Query, BackgroundTasks
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import datetime
import json

from models.competition import Competition, CrawlTask, DataSource
from schemas.competition import (
    CompetitionCreate, CompetitionUpdate, CompetitionResponse, CompetitionSearch,
    PaginationResponse, ResponseMessage, StatsResponse
)
from database import SessionLocal

router = APIRouter()

# 数据库依赖
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# 赛事相关API

@router.get("/", response_model=PaginationResponse)
def get_competitions(
    db: Session = Depends(get_db),
    page: int = Query(1, ge=1),
    size: int = Query(10, ge=1, le=100),
    search: Optional[str] = Query(None),
    category: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    startDate: Optional[datetime] = Query(None),
    endDate: Optional[datetime] = Query(None)
):
    """获取赛事列表"""
    try:
        # 构建查询
        query = db.query(Competition)
        
        # 搜索过滤
        if search:
            query = query.filter(Competition.title.contains(search))
            
        # 分类过滤
        if category:
            # 这里应该根据category查询对应的分类名称
            # 暂时使用固定的映射
            category_mapping = {
                1: "科技创新",
                2: "体育竞技", 
                3: "艺术文化",
                4: "学术竞赛",
                5: "创客动手",
                6: "户外探索"
            }
            category_name = category_mapping.get(category)
            if category_name:
                query = query.filter(Competition.category == category_name)
        
        # 状态过滤
        if status:
            query = query.filter(Competition.status == status)
        
        # 地区过滤
        if region:
            query = query.filter(Competition.location.contains(region))
        
        # 日期过滤
        if startDate:
            query = query.filter(Competition.endDate >= startDate)
        if endDate:
            query = query.filter(Competition.startDate <= endDate)
        
        # 分页
        total = query.count()
        competitions = query.offset((page - 1) * size).limit(size).all()
        
        return {
            "items": competitions,
            "total": total,
            "page": page,
            "size": size,
            "totalPages": (total + size - 1) // size
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/latest", response_model=List[CompetitionResponse])
def get_latest_competitions(
    db: Session = Depends(get_db),
    limit: int = Query(6, ge=1, le=20)
):
    """获取最新赛事"""
    try:
        competitions = db.query(Competition)\
            .filter(Competition.isVisible == True)\
            .order_by(Competition.createdAt.desc())\
            .limit(limit)\
            .all()
        return competitions
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{competition_id}", response_model=CompetitionResponse)
def get_competition(
    competition_id: int,
    db: Session = Depends(get_db)
):
    """获取单个赛事详情"""
    competition = db.query(Competition).filter(Competition.id == competition_id).first()
    if not competition:
        raise HTTPException(status_code=404, detail="赛事未找到")
    
    # 增加浏览次数
    competition.viewCount += 1
    db.commit()
    
    return competition

@router.post("/", response_model=CompetitionResponse)
def create_competition(
    competition: CompetitionCreate,
    db: Session = Depends(get_db)
):
    """创建新赛事"""
    try:
        db_competition = Competition(**competition.dict())
        db.add(db_competition)
        db.commit()
        db.refresh(db_competition)
        
        # 添加到爬虫任务表
        crawl_task = CrawlTask(
            platform="手动添加",
            url="",  # 手动添加的赛事，没有原始URL
            status="completed"
        )
        db.add(crawl_task)
        db.commit()
        
        return db_competition
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/{competition_id}", response_model=CompetitionResponse)
def update_competition(
    competition_id: int,
    competition_data: CompetitionUpdate,
    db: Session = Depends(get_db)
):
    """更新赛事信息"""
    competition = db.query(Competition).filter(Competition.id == competition_id).first()
    if not competition:
        raise HTTPException(status_code=404, detail="赛事未找到")
    
    try:
        # 更新字段
        update_data = competition_data.dict(exclude_unset=True)
        for field, value in update_data.items():
            setattr(competition, field, value)
        
        competition.updatedAt = datetime.utcnow()
        db.commit()
        db.refresh(competition)
        
        return competition
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/{competition_id}", response_model=ResponseMessage)
def delete_competition(
    competition_id: int,
    db: Session = Depends(get_db)
):
    """删除赛事"""
    competition = db.query(Competition).filter(Competition.id == competition_id).first()
    if not competition:
        raise HTTPException(status_code=404, detail="赛事未找到")
    
    try:
        db.delete(competition)
        db.commit()
        
        return {
            "message": "赛事删除成功",
            "success": True
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/stats/overview", response_model=StatsResponse)
def get_competition_stats(db: Session = Depends(get_db)):
    """获取赛事统计信息"""
    try:
        total = db.query(Competition).filter(Competition.isVisible == True).count()
        
        # 统计分类数量
        categories = db.query(Competition.category).distinct().all()
        categorized_count = len([c[0] for c in categories if c[0]])
        
        # 统计数据源数量
        platforms = db.query(DataSource.platform).distinct().filter(DataSource.isActive == True).all()
        platforms_count = len([p[0] for p in platforms if p[0]])
        
        # 今天的更新数量
        today = datetime.now().date()
        today_count = db.query(Competition).filter(
            Competition.createdAt >= today,
            Competition.isCrawled == True
        ).count()
        
        return {
            "total": total,
            "categorized": categorized_count,
            "platforms": platforms_count,
            "updates": today_count
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/bulk", response_model=ResponseMessage)
def bulk_update_competitions():
    """批量更新赛事信息"""
    # TODO: 实现批量更新功能
    return {
        "message": "批量更新功能开发中",
        "success": True
    }

@router.post("/{competition_id}/participants", response_model=ResponseMessage)
def add_participant(
    competition_id: int,
    db: Session = Depends(get_db)
):
    """增加报名人数"""
    competition = db.query(Competition).filter(Competition.id == competition_id).first()
    if not competition:
        raise HTTPException(status_code=404, detail="赛事未找到")
    
    try:
        competition.participants += 1
        competition.updatedAt = datetime.utcnow()
        db.commit()
        
        return {
            "message": "报名人数已更新",
            "success": True
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))