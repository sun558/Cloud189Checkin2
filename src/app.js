require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
log4js.configure({
  appenders: {
    vcr: {
      type: "recording",
    },
    out: {
      type: "console",
    },
  },
  categories: { default: { appenders: ["vcr", "out"], level: "info" } },
});

const logger = log4js.getLogger();
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");
const serverChan = require("./push/serverChan");
const telegramBot = require("./push/telegramBot");
const wecomBot = require("./push/wecomBot");
const wxpush = require("./push/wxPusher");
const accounts = require("../accounts");
const families = require("../families");
const execThreshold = process.env.EXEC_THRESHOLD || 1;
const accountPerson = process.env.ACCOUNT_PERSON || 1; //主账号个数


const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 任务 1.签到
const doUserTask = async (cloudClient,index) => {
	if(index < accountPerson){
		const result = [];
		const res1 = await cloudClient.userSign();
		result.push(
				'个人'+`${res1.isSign ? "无效" : ""}签到: ${res1.netdiskBonus}M`
	);
		await delay(5000); // 延迟5秒
		return result;
	}else{		
		return "";
	}
};

const doFamilyTask = async (cloudClient,index) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  if (familyInfoResp) {
    let familyId = null;
    //指定家庭签到
    if (families.length > 0) {
      const tagetFamily = familyInfoResp.find((familyInfo) =>
        families.includes(familyInfo.familyId)
      );
      if (tagetFamily) {
        familyId = tagetFamily.familyId;
      } else {
        return [
          `没有加入到指定家庭分组`,
        ];
      }
    } else {
      familyId = familyInfoResp[0].familyId;
    }
    
	if(index < accountPerson ){
		const res = await cloudClient.familyUserSign(familyId);
		return res.signStatus ? undefined : [res.bonusSpace] ;
		
	}else{
		const tasks = Array.from({ length: execThreshold }, () =>
		cloudClient.familyUserSign(familyId)
		);
		// 等待所有任务完成，并过滤出尚未签到的家庭用户
		const results = (await Promise.all(tasks)).filter(res => !res.signStatus);
		return  results.length === 0 ? 
				undefined : results.map((res) => res.bonusSpace);
		
	}
		
  }
  return [];
};

const pushServerChan = (title, desp) => {
  if (!serverChan.sendKey) {
    return;
  }
  const data = {
    title,
    desp,
  };
  superagent
    .post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
    .type("form")
    .send(data)
    .end((err, res) => {
      if (err) {
        logger.error(`ServerChan推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (json.code !== 0) {
        logger.error(`ServerChan推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("ServerChan推送成功");
      }
    });
};

const pushTelegramBot = (title, desp) => {
  if (!(telegramBot.botToken && telegramBot.chatId)) {
    return;
  }
  const data = {
    chat_id: telegramBot.chatId,
    text: `${title}\n\n${desp}`,
  };
  superagent
    .post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
    .type("form")
    .send(data)
    .end((err, res) => {
      if (err) {
        logger.error(`TelegramBot推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (!json.ok) {
        logger.error(`TelegramBot推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("TelegramBot推送成功");
      }
    });
};

const pushWecomBot = (title, desp) => {
  if (!(wecomBot.key && wecomBot.telphone)) {
    return;
  }
  const data = {
    msgtype: "text",
    text: {
      content: `${title}\n\n${desp}`,
      mentioned_mobile_list: [wecomBot.telphone],
    },
  };
  superagent
    .post(
      `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`
    )
    .send(data)
    .end((err, res) => {
      if (err) {
        logger.error(`wecomBot推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (json.errcode) {
        logger.error(`wecomBot推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("wecomBot推送成功");
      }
    });
};

const pushWxPusher = (title, desp) => {
  if (!(wxpush.appToken && wxpush.uid)) {
    return;
  }
  const data = {
    appToken: wxpush.appToken,
    contentType: 1,
    summary: title,
    content: desp,
    uids: [wxpush.uid],
  };
  superagent
    .post("https://wxpusher.zjiecode.com/api/send/message")
    .send(data)
    .end((err, res) => {
      if (err) {
        logger.error(`wxPusher推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (json.data[0].code !== 1000) {
        logger.error(`wxPusher推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("wxPusher推送成功");
      }
    });
};

const push = (title, desp) => {
  pushServerChan(title, desp);
  pushTelegramBot(title, desp);
  pushWecomBot(title, desp);
  pushWxPusher(title, desp);
};

// 开始执行程序
async function main() {	
  //用于统计实际容量变化
  const userSizeInfoMap = new Map();
  let mainAccountCount  = 0 ; //主账号详情循环
  let NonPrimaryCount = 0 ; //非主账号变化循环
  
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    const { userName, password } = account;
    if (userName && password) {
      const userNameInfo = mask(userName, 3, 7);
      try {
        logger.log(`${index+1}. 账户 ${userNameInfo}开始执行`);
        const cloudClient = new CloudClient(userName, password);
        await cloudClient.login();
        const beforeUserSizeInfo = await cloudClient.getUserSizeInfo();
        userSizeInfoMap.set(userName, {
          cloudClient,
          userSizeInfo: beforeUserSizeInfo,
        });
		const result = await doUserTask(cloudClient,index);
		if(result){
			result.forEach((r) => logger.log(r));
		}
		
        const familyResult = await doFamilyTask(cloudClient,index);
		const signedMessage = familyResult?.length > 0 
				? familyResult.every(item => typeof item === 'number')
				? `家庭有效签到${familyResult.length}次(M): ${familyResult.join(' ')}`
				: `${familyResult.join(' ')}`
				: '家庭重复无效签到';

			logger.log(signedMessage);
        await delay((Math.random() * 3000) + 3000); // 随机等待3到6秒
      } catch (e) {
        logger.error(e);
        if (e.code === "ETIMEDOUT") {
          throw e;
        }
      } finally {
        logger.log(` `);
      }
    }
  }
	
  

  //非主账号变化详情
  for (const [userName, { cloudClient, userSizeInfo }] of userSizeInfoMap) {
    const userNameInfo = mask(userName, 3, 7);
    const afterUserSizeInfo = await cloudClient.getUserSizeInfo();
	if(NonPrimaryCount < accountPerson ){
		NonPrimaryCount++;
		continue;
	}
	if(afterUserSizeInfo.familyCapacityInfo.totalSize != userSizeInfo.familyCapacityInfo.totalSize ){
	  logger.log(`非主账户 ${userNameInfo}实际容量变化:`);
		logger.log(
		`个人总容量增加：${(
			(afterUserSizeInfo.cloudCapacityInfo.totalSize -
			userSizeInfo.cloudCapacityInfo.totalSize) /
			1024 /
			1024
		).toFixed(2)}M,家庭容量增加：${(
			(afterUserSizeInfo.familyCapacityInfo.totalSize -
			userSizeInfo.familyCapacityInfo.totalSize) /
			1024 /
			1024
		).toFixed(2)}M`
		);
	}
    NonPrimaryCount++;
  }
	logger.log(' ');
  
  //主账号家庭详情
	for (const [userName, { cloudClient, userSizeInfo }] of userSizeInfoMap){
	   if(mainAccountCount < accountPerson){
	        const userNameInfo = mask(userName, 3, 7);
			const afterUserSizeInfo = await cloudClient.getUserSizeInfo();
			logger.log(`账户 ${userNameInfo}:`);
			logger.log(`前 个人：${ (
			(userSizeInfo.cloudCapacityInfo.totalSize) /
			1024 /
			1024 /
			1024
		).toFixed(3)}G, 家庭：${(
			( userSizeInfo.familyCapacityInfo.totalSize) /
			1024 /
			1024 /
			1024
		).toFixed(3)}G`);
		logger.log(`后 个人：${(
			(afterUserSizeInfo.cloudCapacityInfo.totalSize) /
			1024 /
			1024 /
			1024
		).toFixed(3)}G, 家庭：${(
			(afterUserSizeInfo.familyCapacityInfo.totalSize) /
			1024 /
			1024 /
			1024
		).toFixed(3)}G`);
		logger.log(
		`个人总容量增加：${(
			(afterUserSizeInfo.cloudCapacityInfo.totalSize -
			userSizeInfo.cloudCapacityInfo.totalSize) /
			1024 /
			1024
		).toFixed(2)}M,家庭容量增加：${(
			(afterUserSizeInfo.familyCapacityInfo.totalSize -
			userSizeInfo.familyCapacityInfo.totalSize) /
			1024 /
			1024
		).toFixed(2)}M`
		);
		
		 mainAccountCount++;
	   }else{
			break;
	   }
	}
	
}
function getLineIndex(str, lineIndex) {
  // 参数校验
  if (typeof str !== 'string' || !Number.isInteger(lineIndex)) {
    return '';
  }

  // 单次分割处理（兼容不同系统换行符）
  const lines = str.split(/\r?\n/);
  
  // 处理边界情况
  return lineIndex >= 0 && lineIndex < lines.length 
    ? String(lines[lineIndex]).trim() // 移除前后空格
    : '';
}

(async () => {
  try {
    await main();
  } finally {
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");
	const lineCount = content.split('\n').length;
    push(` ${getLineIndex(content,lineCount - 4).slice(12, 14)}天翼${getLineIndex(content, lineCount - 1).slice(-12)}`, content);
    recording.erase();
  }
})();
