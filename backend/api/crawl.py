from fastapi import APIRouter, HTTPException, Query, BackgroundTasks, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from typing import List, Dict, Optional
import requests
from bs4 import BeautifulSoup
import re
import json
import time
import asyncio
from datetime import datetime, timedelta
import logging

from database import SessionLocal
from models.competition import Competition, CrawlTask, CrawlSchedule, DataSource
from schemas.competition import (
    CrawlTaskCreate, CrawlTaskUpdate, CrawlTaskResponse,
    CrawlScheduleCreate, CrawlScheduleResponse
)

router = APIRouter()

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 数据库依赖
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# 爬虫配置
class CrawlerConfig(BaseModel):
    platform: str
    base_url: str
    url_pattern: str
    headers: Dict[str, str] = {}
    max_retries: int = 3
    timeout: int = 30
    delay: float = 1.0

# 支持的数据源配置
DATA_SOURCES = {
    "教育部": {
        "base_url": "https://www.moe.gov.cn",
        "url_pattern": "/s5743.htm",
        "headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        "parse_method": "list"
    },
    "创新大赛": {
        "base_url": "https://www.innofair.com.cn",
        "url_pattern": "/list",
        "headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        "parse_method": "list"
    },
    "竞赛管家": {
        "base_url": "https://www.saomeng.com",
        "url_pattern": "/competition/list",
        "headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        "parse_method": "list"
    }
}

# 爬虫任务队列
crawl_queue = asyncio.Queue()

async def run_crawler(background_tasks: BackgroundTasks):
    """运行爬虫任务"""
    while True:
        try:
            task_data = await asyncio.wait_for(crawl_queue.get(), timeout=1.0)
            await process_crawl_task(task_data)
        except asyncio.TimeoutError:
            continue

async def process_crawl_task(task_data: Dict):
    """处理单个爬虫任务"""
    try:
        task_id = task_data["id"]
        platform = task_data["platform"]
        url = task_data["url"]
        
        # 获取爬虫配置
        config = DATA_SOURCES.get(platform)
        if not config:
            logger.error(f"未找到 {platform} 的爬虫配置")
            return
        
        # 创建爬虫任务记录
        db = SessionLocal()
        try:
            crawl_task = db.query(CrawlTask).filter(CrawlTask.id == task_id).first()
            if not crawl_task:
                logger.error(f"找不到爬虫任务: {task_id}")
                return
            
            # 更新任务状态
            crawl_task.status = "running"
            crawl_task.startTime = datetime.utcnow()
            db.commit()
            
            logger.info(f"开始爬取任务 {task_id}: {platform} - {url}")
            
            # 执行爬取
            competitions = await crawl_competitions(url, config, platform)
            
            # 处理爬取结果
            processed_count = 0
            success_count = 0
            error_count = 0
            
            for comp_data in competitions:
                try:
                    # 检查是否已存在相同赛事
                    exists = db.query(Competition).filter(
                        Competition.title == comp_data["title"],
                        Competition.dataSource == platform
                    ).first()
                    
                    if not exists:
                        # 创建新赛事
                        comp = Competition(
                            title=comp_data["title"],
                            category=comp_data.get("category", "未分类"),
                            status=comp_data.get("status", "招募中"),
                            description=comp_data.get("description", ""),
                            details=comp_data.get("details", ""),
                            startDate=datetime.strptime(comp_data["startDate"], "%Y-%m-%d"),
                            endDate=datetime.strptime(comp_data["endDate"], "%Y-%m-%d"),
                            registrationStartDate=datetime.strptime(comp_data["startDate"], "%Y-%m-%d"),
                            registrationEndDate=datetime.strptime(comp_data.get("registrationDeadline", comp_data["endDate"]), "%Y-%m-%d"),
                            location=comp_data.get("location", "线上"),
                            registrationFee=comp_data.get("fee", "免费"),
                            organizer=comp_data.get("organizer", ""),
                            guidingOrganization=comp_data.get("guidance", ""),
                            registrationMethod=comp_data.get("registrationMethod", ""),
                            dataSource=platform,
                            originalUrl=comp_data.get("url", ""),
                            isCrawled=True
                        )
                        db.add(comp)
                        success_count += 1
                        processed_count += 1
                    else:
                        processed_count += 1
                        
                except Exception as e:
                    error_count += 1
                    logger.error(f"处理赛事数据失败: {e}")
            
            # 更新爬虫任务状态
            crawl_task.status = "completed"
            crawl_task.endTime = datetime.utcnow()
            crawl_task.duration = (crawl_task.endTime - crawl_task.startTime).total_seconds()
            crawl_task.processedCount = processed_count
            crawl_task.successCount = success_count
            crawl_task.errorCount = error_count
            
            db.commit()
            logger.info(f"爬虫任务完成: {task_id} - 成功: {success_count}, 失败: {error_count}")
            
        except Exception as e:
            logger.error(f"爬虫任务 {task_id} 执行失败: {e}")
            
            # 更新任务状态为失败
            crawl_task.status = "failed"
            crawl_task.endTime = datetime.utcnow()
            crawl_task.errorMessage = str(e)
            db.commit()
            
        finally:
            db.close()
            
    except Exception as e:
        logger.error(f"处理爬虫任务失败: {e}")

async def crawl_competitions(url: str, config: Dict, platform: str) -> List[Dict]:
    """爬取赛事信息"""
    competitions = []
    session = requests.Session()
    session.headers.update(config.get("headers", {}))
    
    try:
        # 获取页面内容
        response = session.get(url, timeout=config.get("timeout", 30))
        response.raise_for_status()
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        if platform == "教育部":
            # 教育部页面解析
            return parse_moe_website(soup)
        elif platform == "创新大赛":
            # 创新大赛页面解析
            return parse_innofair_website(soup)
        elif platform == "竞赛管家":
            # 竞赛管家页面解析
            return parse_saomeng_website(soup)
        else:
            raise ValueError(f"不支持的爬取平台: {platform}")
            
    except Exception as e:
        logger.error(f"爬取 {platform} 失败: {e}")
        raise

def parse_moe_website(soup: BeautifulSoup) -> List[Dict]:
    """解析教育部网站"""
    competitions = []
    
    # 查找赛事列表
    competition_items = soup.find_all('li', class_='news-list-item')
    
    for item in competition_items:
        try:
            title = item.find('a').text.strip()
            url = item.find('a')['href']
            date_str = item.find('span', class_='date').text.strip()
            
            # 生成详情页面URL
            full_url = f"https://www.moe.gov.cn{url}"
            
            competitions.append({
                "title": title,
                "url": full_url,
                "category": "学术竞赛",
                "status": "招募中",
                "startDate": date_str,
                "endDate": date_str,
                "registrationDeadline": date_str,
                "location": "线上",
                "fee": "免费",
                "organizer": "教育部",
                "guidance": "基础教育司",
                "registrationMethod": "官网报名",
                "description": f"{title} - 教育部主办赛事",
                "details": f"官方链接: {full_url}"
            })
            
        except Exception as e:
            logger.error(f"解析教育部赛事失败: {e}")
    
    return competitions

def parse_innofair_website(soup: BeautifulSoup) -> List[Dict]:
    """解析创新大赛网站"""
    competitions = []
    
    # 查找赛事项目
    project_items = soup.find_all('div', class_='project-item')
    
    for item in project_items:
        try:
            title = item.find('h3').text.strip()
            desc = item.find('p', class_='description').text.strip()
            
            # 提取日期信息（假设在标题中）
            date_match = re.search(r'\d{4}-\d{2}-\d{2}', title)
            date_str = date_match.group() if date_match else "2024-01-01"
            
            competitions.append({
                "title": title,
                "url": "https://www.innofair.com.cn/" + item.find('a')['href'],
                "category": "科技创新",
                "status": "报名中",
                "startDate": date_str,
                "endDate": date_str,
                "registrationDeadline": date_str,
                "location": "全国",
                "fee": "免费",
                "organizer": "创新大赛组委会",
                "guidance": "科技部",
                "registrationMethod": "在线提交",
                "description": desc,
                "details": desc
            })
            
        except Exception as e:
            logger.error(f"解析创新大赛赛事失败: {e}")
    
    return competitions

def parse_saomeng_website(soup: BeautifulSoup) -> List[Dict]:
    """解析竞赛管家网站"""
    competitions = []
    
    # 查找竞赛卡片
    cards = soup.find_all('div', class_='competition-card')
    
    for card in cards:
        try:
            title = card.find('h4').text.strip()
            detail = card.find('div', class_='detail').text.strip()
            
            competitions.append({
                "title": title,
                "url": "https://www.saomeng.com/" + card.find('a')['href'],
                "category": "综合竞赛",
                "status": "报名中",
                "startDate": "2024-01-01",
                "endDate": "2024-03-01",
                "registrationDeadline": "2024-02-01",
                "location": "线上线下结合",
                "fee": "收费",
                "organizer": "竞赛管家",
                "guidance": "教育部",
                "registrationMethod": "官网报名",
                "description": detail,
                "details": detail
            })
            
        except Exception as e:
            logger.error(f"解析竞赛管家赛事失败: {e}")
    
    return competitions

# API 路由

@router.post("/start", response_model=Dict)
async def start_crawl_task(
    background_tasks: BackgroundTasks,
    platform: str = Query(..., description="爬取平台"),
    urls: str = Query(..., description="爬取URL，多个URL用逗号分隔"),
    db: Session = Depends(get_db)
):
    """启动爬虫任务"""
    if platform not in DATA_SOURCES:
        raise HTTPException(status_code=400, detail=f"不支持的平台: {platform}")
    
    url_list = [url.strip() for url in urls.split(",")]
    
    if not url_list:
        raise HTTPException(status_code=400, detail="请提供至少一个URL")
    
    # 创建爬虫任务
    crawl_task = CrawlTask(
        platform=platform,
        url=url_list[0],  # 保存第一个URL
        status="pending"
    )
    
    db.add(crawl_task)
    db.commit()
    db.refresh(crawl_task)
    
    # 添加到爬取队列
    await crawl_queue.put({
        "id": crawl_task.id,
        "platform": platform,
        "url": url_list[0]
    })
    
    return {
        "message": f"爬虫任务已启动: {platform}",
        "success": True,
        "task_id": crawl_task.id,
        "urls": url_list
    }

@router.get("/tasks", response_model=List[CrawlTaskResponse])
def get_crawl_tasks(
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None, description="任务状态筛选"),
    platform: Optional[str] = Query(None, description="平台筛选"),
    limit: int = Query(50, ge=1, le=200)
):
    """获取爬虫任务列表"""
    query = db.query(CrawlTask)
    
    if status:
        query = query.filter(CrawlTask.status == status)
    
    if platform:
        query = query.filter(CrawlTask.platform == platform)
    
    tasks = query.order_by(CrawlTask.createdAt.desc()).limit(limit).all()
    return tasks

@router.get("/tasks/{task_id}")
def get_crawl_task(
    task_id: int,
    db: Session = Depends(get_db)
):
    """获取单个爬虫任务详情"""
    task = db.query(CrawlTask).filter(CrawlTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="爬虫任务未找到")
    
    return task

@router.post("/tasks/{task_id}/stop", response_model=Dict)
async def stop_crawl_task(
    task_id: int,
    db: Session = Depends(get_db)
):
    """停止爬虫任务"""
    task = db.query(CrawlTask).filter(CrawlTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="爬虫任务未找到")
    
    if task.status == "running":
        task.status = "stopped"
        task.endTime = datetime.utcnow()
        db.commit()
        
        return {
            "message": f"爬虫任务 {task_id} 已停止",
            "success": True
        }
    
    raise HTTPException(status_code=400, detail="任务未在运行中")

@router.get("/platforms", response_model=List[Dict])
def get_available_platforms():
    """获取可用的爬取平台"""
    platforms = []
    for name, config in DATA_SOURCES.items():
        platforms.append({
            "name": name,
            "base_url": config["base_url"],
            "url_pattern": config["url_pattern"],
            "enabled": True
        })
    return platforms

@router.post("/schedule", response_model=CrawlTaskResponse)
async def schedule_crawl_task(
    task: CrawlTaskCreate,
    db: Session = Depends(get_db)
):
    """定时爬虫任务"""
    crawl_task = CrawlTask(**task.dict())
    db.add(crawl_task)
    db.commit()
    db.refresh(crawl_task)
    
    return crawl_task

@router.get("/stats", response_model=Dict)
def get_crawl_stats(db: Session = Depends(get_db)):
    """获取爬虫统计信息"""
    # 总任务数
    total_tasks = db.query(CrawlTask).count()
    
    # 成功任务数
    success_tasks = db.query(CrawlTask).filter(CrawlTask.status == "completed").count()
    
    # 进行中任务数
    running_tasks = db.query(CrawlTask).filter(CrawlTask.status == "running").count()
    
    # 失败任务数
    failed_tasks = db.query(CrawlTask).filter(CrawlTask.status == "failed").count()
    
    # 今日爬取数
    today = datetime.now().date()
    today_tasks = db.query(CrawlTask).filter(
        db.func.date(CrawlTask.createdAt) == today,
        CrawlTask.status == "completed"
    ).count()
    
    return {
        "total_tasks": total_tasks,
        "success_tasks": success_tasks,
        "running_tasks": running_tasks,
        "failed_tasks": failed_tasks,
        "success_rate": success_tasks / total_tasks * 100 if total_tasks > 0 else 0,
        "today_tasks": today_tasks
    }

# 启动爬虫任务处理器
async def start_crawler_processor():
    """启动爬虫任务处理器后台任务"""
    background_tasks = BackgroundTasks()
    await run_crawler(background_tasks)
    
# 启动任务处理器
async def startup_task():
    await start_crawler_processor()